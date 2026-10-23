#!/usr/bin/env node
"use strict";
/*
 * xtboard server — thin node:http layer over core.js (zero deps).
 *
 * All state reads/mutations go through core.js with NO second state logic;
 * this file only speaks HTTP. Refusals surface core's own messages:
 * paused board  → 403 "board 'X' is paused — resume the board before claiming"
 * global HALT   → 403 "orchestrator is HALTED — no new work may be claimed (resume to lift)"
 *
 * Config (env): XTBOARD_PORT (default 9119), XTBOARD_HOST (default 127.0.0.1;
 * use 0.0.0.0 for the CasaOS docker-compose exposure), XTBOARD_HOME (default
 * ~/.pi/xtboard, per core.js).
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const core = require(path.join(__dirname, "core.js"));

const PORT = Number(process.env.XTBOARD_PORT || 9119);
const HOST = process.env.XTBOARD_HOST || "127.0.0.1";
const UI_FILE = path.join(__dirname, "index.html");
const ACTOR = "web";

/* ============================ low-level helpers ============================ */

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendHtml(res, code, html) {
  res.writeHead(code, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function httpErr(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    let done = false;
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        if (!done) {
          done = true;
          reject(httpErr(400, "body too large"));
        }
        req.destroy();
        return;
      }
    });
    req.on("end", () => {
      if (!done) {
        done = true;
        resolve(data);
      }
    });
    req.on("error", (err) => {
      if (!done) {
        done = true;
        reject(err);
      }
    });
  });
}

function jsonBody(raw) {
  if (raw == null || raw === "") return {};
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    throw httpErr(400, "invalid JSON body");
  }
  if (v == null || typeof v !== "object" || Array.isArray(v)) throw httpErr(400, "JSON body must be an object");
  return v;
}

function serveUi(res) {
  let html = null;
  try {
    html = fs.readFileSync(UI_FILE, "utf8");
  } catch {
    html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>xtboard</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#101018;color:#e8e8f0;font:15px/1.6 system-ui,Segoe UI,Roboto,sans-serif}
  .card{max-width:520px;padding:2rem 2.5rem;border:1px solid #2a2a3a;border-radius:14px;background:#161622}
  h1{margin:0 0 .4rem;font-size:1.5rem;letter-spacing:.02em}
  .sub{color:#9a9ab0;margin:0 0 1rem}
  code{background:#20203a;padding:.1rem .4rem;border-radius:5px;font-size:.85em}
  ul{margin:.5rem 0 0;padding-left:1.2rem;color:#c8c8d8}
</style></head><body>
  <div class="card">
    <h1>xtboard</h1>
    <p class="sub">UI pending — the API is live on this port:</p>
    <ul>
      <li><code>GET /api/healthz</code> — liveness</li>
      <li><code>GET /api/state</code> — boards, tasks, counts</li>
      <li><code>GET /api/stream</code> — SSE updates (state / halt / runs)</li>
      <li><code>POST /api/boards</code> · <code>POST /api/tasks</code> · <code>* /api/tasks/&lt;id&gt;/&lt;action&gt;</code></li>
      <li><code>POST /api/halt</code> · <code>POST /api/resume</code></li>
    </ul>
  </div>
</body></html>`;
  }
  sendHtml(res, 200, html);
}

/* ============================== SSE (event stream) ===========================
 * core.js exposes on(evt) for in-process mutations and the state files are the
 * source of truth, so the stream is: immediate "state" event on connect +
 * ~500 ms mtime/size diff of board.json / halt.json / runs.json (catches
 * CLI-side mutations from other processes). Core events also fire instantly.
 */
const sseClients = new Set();

function sseWrite(client, type, payload) {
  if (!client.alive) return;
  try {
    client.res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ts: nowTs(), ...(payload || {}) })}\n\n`);
  } catch {
    /* client went away */
  }
}

function nowTs() {
  return core.now();
}

function emitSse(type, payload) {
  for (const c of [...sseClients]) sseWrite(c, type, payload);
}

function openSse(req, res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": xtboard stream\n\n");
  const client = { res, alive: true };
  sseClients.add(client);
  sseWrite(client, "state", { initial: true });
  req.on("close", () => {
    client.alive = false;
    sseClients.delete(client);
  });
  // The response lives until the client closes; the route promise never settles.
  return new Promise(() => {});
}

function sigOf(file) {
  try {
    const s = fs.statSync(file);
    return `${s.mtimeMs}|${s.size}`;
  } catch {
    return "absent";
  }
}

let lastSig = null;

function startSsePolling() {
  const paths = { state: core.boardPath(), halt: core.haltPath(), runs: core.runsPath() };
  lastSig = { state: sigOf(paths.state), halt: sigOf(paths.halt), runs: sigOf(paths.runs) };
  const timer = setInterval(() => {
    if (!sseClients.size) return;
    const sig = { state: sigOf(paths.state), halt: sigOf(paths.halt), runs: sigOf(paths.runs) };
    if (sig.state !== lastSig.state) {
      lastSig.state = sig.state;
      emitSse("state", {});
    }
    if (sig.halt !== lastSig.halt) {
      lastSig.halt = sig.halt;
      emitSse("halt", { halted: !!core.halted() });
    }
    if (sig.runs !== lastSig.runs) {
      lastSig.runs = sig.runs;
      emitSse("runs", {});
    }
  }, 500);
  timer.unref && timer.unref();
  return timer;
}

const unsubs = core.on((evt) => {
  if (evt.kind === "halt") emitSse("halt", { halted: !!core.halted() });
  else if (evt.kind === "runs") emitSse("runs", {});
  else emitSse("state", {});
});

/* ================================ routing ================================= */

function routeBoard(path, method, req, res, next) {
  const m = path.match(/^\/api\/boards(?:\/([^/]+))?$/);
  if (!m) { next && next(); return undefined; }
  const [, idOrName] = m;
  if (method === "POST" && !idOrName) {
    return readBody(req).then((raw) => {
      const body = jsonBody(raw);
      const bd = core.mutate(`board added (web): ${body.name || ""}`, (b) => core.addBoardIn(b, body.name), { by: ACTOR });
      json(res, 201, bd);
    });
  }
  if (method === "PATCH" && idOrName) {
    return readBody(req).then((raw) => {
      const body = jsonBody(raw);
      if (body.name == null && typeof body.active !== "boolean") throw httpErr(400, "send {name} and/or {active}");
      const bd = core.mutate(`board '${idOrName}' updated (web)`, (b) => {
        if (body.name != null) core.setBoardNameIn(b, idOrName, body.name);
        if (typeof body.active === "boolean") core.setBoardActiveIn(b, idOrName, body.active);
        return core.findBoard(b, idOrName);
      }, { by: ACTOR });
      json(res, 200, bd);
    });
  }
  if (method === "DELETE" && idOrName) {
    const bd = core.mutate(`board removed (web): ${idOrName}`, (b) => core.removeBoardIn(b, idOrName), { by: ACTOR });
    return json(res, 200, bd);
  }
  throw httpErr(405, `method ${method} not allowed for /api/boards${idOrName ? "/" + idOrName : ""}`);
}

function routeTask(path, method, req, res, next) {
  const m = path.match(/^\/api\/tasks(?:\/([^/]+)(?:\/([a-z]+))?)?$/);
  if (!m) { next && next(); return undefined; }
  const [, id, action] = m;

  if (method === "POST" && !id) {
    return readBody(req).then((raw) => {
      const body = jsonBody(raw);
      const t = core.mutate(`task added (web): ${body.title || ""}`, (b) =>
        core.addTaskIn(b, {
          title: body.title,
          boardId: body.board,
          owner: body.owner,
          status: body.status,
          note: body.note,
          blocked_reason: body.blocked_reason,
        })
      , { by: ACTOR });
      json(res, 201, t);
    });
  }
  if (!id) throw httpErr(405, `method ${method} not allowed for /api/tasks`);

  if (method === "PATCH" && !action) {
    return readBody(req).then((raw) => {
      const body = jsonBody(raw);
      if (Object.keys(body).length === 0) throw httpErr(400, "empty patch; send {title,owner,note,status,blocked_reason,board}")
      const t = core.mutate(`task ${id} updated (web)`, (b) => core.patchTaskIn(b, id, body), { by: ACTOR });
      json(res, 200, t);
    });
  }
  if (method === "POST" && action) {
    const actions = {
      log: { fn: (b, body) => core.logIn(b, id, body.msg, ACTOR), label: "logged (web)" },
      claim: { fn: (b, body) => core.claimIn(b, id, { name: String(body.worker || ACTOR) }), label: "claimed by {worker}" },
      release: { fn: (b) => core.releaseIn(b, id), label: "released (web)" },
      fail: { fn: (b, body) => core.failIn(b, id, body.reason), label: "failed (web)" },
      done: { fn: (b, body) => core.doneIn(b, id, body.note), label: "done (web)" },
      block: { fn: (b, body) => core.blockIn(b, id, body.reason, body.note), label: "blocked (web)" },
      unblock: { fn: (b, body) => core.unblockIn(b, id, body.note), label: "unblocked (web)" },
    };
    const spec = actions[action];
    if (!spec) throw httpErr(404, `unknown task action: /api/tasks/${id}/${action}`);
    return readBody(req).then((raw) => {
      const body = jsonBody(raw);
      const t = core.mutate(`task ${id} ${spec.label.replace("{worker}", body.worker || ACTOR)}`, (b) => spec.fn(b, body), { by: ACTOR });
      json(res, 200, t);
    });
  }
  throw httpErr(405, `method ${method} not allowed for /api/tasks/${id}${action ? "/" + action : ""}`);
}

async function route(req, res) {
  let u;
  try {
    u = new URL(req.url, "http://localhost");
  } catch {
    throw httpErr(400, "bad request target");
  }
  const p = u.pathname;
  const method = req.method.toUpperCase();
  const next = () => {
    throw httpErr(404, `not found: ${method} ${p}`);
  };

  if (method === "GET" && (p === "/" || p === "/index.html")) return serveUi(res);
  if (method === "GET" && p === "/api/healthz") return json(res, 200, { status: "ok", ts: nowTs(), halted: !!core.halted() });
  if (method === "GET" && p === "/api/state") return json(res, 200, core.state());
  if (method === "GET" && p === "/api/stream") return openSse(req, res);
  if (method === "POST" && p === "/api/halt") {
    const body = jsonBody(await readBody(req));
    const mode = body.mode || "drain";
    if (mode !== "drain" && mode !== "kill") throw httpErr(400, "halt mode must be 'drain' or 'kill'");
    const info = core.haltAction({ mode, unload: !!body.unload, by: ACTOR });
    return json(res, 200, info);
  }
  if (method === "POST" && p === "/api/resume") {
    const info = core.resumeAction({ by: ACTOR });
    return json(res, 200, info);
  }

  const viaBoard = routeBoard(p, method, req, res, undefined);
  if (viaBoard) return viaBoard;
  const viaTask = routeTask(p, method, req, res, undefined);
  if (viaTask) return viaTask;
  throw next();
}

/* ================================ startup ================================= */

const server = http.createServer((req, res) => {
  route(req, res).catch((err) => {
    const status = (err && err.status) || 500;
    if (status >= 500) console.error(`[xtboard] ${req.method} ${req.url} → ${status}: ${err && err.message}`);
    if (!res.headersSent) json(res, status, { error: String((err && err.message) || err) });
    else {
      try {
        res.end();
      } catch {
        /* already closed */
      }
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[xtboard] listening on http://${HOST}:${PORT}  (state: ${process.env.XTBOARD_HOME || "~/.pi/xtboard"})`);
  console.log(`[xtboard] SSE: GET /api/stream (state/halt/runs events)`);
  startSsePolling();
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
});

module.exports = { server };
