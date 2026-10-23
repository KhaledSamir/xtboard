#!/usr/bin/env node
"use strict";
/*
 * xtboard core — shared state engine for the `xtb` CLI and `server.js`.
 *
 * Zero npm dependencies (Node 24 builtins only). Both front-ends MUST go
 * through this module so semantics stay identical (claim rules, halt rules,
 * history, caps, log lines).
 *
 * State layout (root = $XTBOARD_HOME or ~/.pi/xtboard):
 *   board.json   { version:2, boards:[{id,name,active,created}], tasks:{...} }
 *   halt.json    { ts, mode, unloaded, killed, marked, ... }
 *   runs.json    [ {job,status,detail,at}, ... ] (newest first, cap 200)
 *   xtboard.log  "[YYYY-MM-DD HH:MM:SS] msg" per line
 *   board.lock   {pid,ts} — O_EXCL lockfile, stale after 30s or dead owner pid
 *
 * v1 task fields are kept (id,title,owner,status,note,claimed_by,fails,
 * last_error,created,updated,history) + v2 additions: board, blocked_reason,
 * logs[], claimed_at, worker_pid.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const child = require("node:child_process");
const events = require("node:events");

const STATUSES = Object.freeze(["todo", "ready", "running", "blocked", "done"]);
const LOGS_CAP = 200;
const HISTORY_CAP = 30;
const RUNS_CAP = 200;
const LOCK_STALE_MS = 30000;
const LOCK_TRIES = 50;
const LOCK_RETRY_MS = 100;

function homedirRoot() {
  return process.env.XTBOARD_HOME || path.join(os.homedir(), ".pi", "xtboard");
}
const boardPath = () => path.join(homedirRoot(), "board.json");
const haltPath = () => path.join(homedirRoot(), "halt.json");
const runsPath = () => path.join(homedirRoot(), "runs.json");
const logPath = () => path.join(homedirRoot(), "xtboard.log");
const lockPath = () => path.join(homedirRoot(), "board.lock");

// Local "%Y-%m-%d %H:%M:%S" like v1.
function now() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function newId(prefix) {
  return prefix + crypto.randomBytes(3).toString("hex"); // t_<6hex> / b_<6hex>
}

function httpErr(status, msg) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

// ---- global activity log (v1 style "[ts] msg"); every mutation appends ----
function glog(msg) {
  fs.mkdirSync(homedirRoot(), { recursive: true });
  fs.appendFileSync(logPath(), `[${now()}] ${msg}\n`);
}

// Newest-first tail of xtboard.log — powers the UI live-activity rail.
function feed(n = 50) {
  let text = "";
  try {
    text = fs.readFileSync(logPath(), "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n").filter(Boolean).slice(-n);
  return lines
    .map((l) => {
      const m = l.match(/^\[(.+?)\] (.*)$/);
      return m ? { ts: m[1], msg: m[2] } : { ts: "", msg: l };
    })
    .reverse();
}

// ---- atomic load/save ----
function loadJson(file, def) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT" || err instanceof SyntaxError) return def;
    throw err;
  }
}
function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file); // atomic
}

// ---- lockfile lock (O_EXCL + stale-timeout + pid check) ----
let lockFd = null;
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function acquireLock() {
  fs.mkdirSync(homedirRoot(), { recursive: true });
  const lock = lockPath();
  for (let i = 0; i < LOCK_TRIES; i++) {
    try {
      lockFd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
      fs.writeSync(lockFd, JSON.stringify({ pid: process.pid, ts: Date.now() }));
      return;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      // Steal the lock if stale (old mtime) or the owner pid is dead.
      try {
        const rec = JSON.parse(fs.readFileSync(lock, "utf8") || "{}");
        const stat = fs.statSync(lock);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS || (rec.pid && rec.pid !== process.pid && !pidAlive(rec.pid))) {
          fs.rmSync(lock, { force: true });
          continue;
        }
      } catch {
        /* unreadable lock — keep waiting */
      }
      // brief sleep before retry (Atomics.wait blocks the thread)
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LOCK_RETRY_MS);
      } catch {
        /* no-Atomics fallback: spin */
      }
    }
  }
  throw new Error("could not acquire board lock (another writer? try again shortly)");
}
function releaseLock() {
  if (lockFd == null) return;
  try {
    fs.closeSync(lockFd);
  } catch { /* already closed */ }
  lockFd = null;
  try {
    if (readLockOwner() === process.pid) fs.rmSync(lockPath(), { force: true });
  } catch { /* fine */ }
}
function readLockOwner() {
  try {
    return JSON.parse(fs.readFileSync(lockPath(), "utf8")).pid;
  } catch {
    return -1;
  }
}

// ---- change bus (server uses it to push SSE immediately) ----
const bus = new events.EventEmitter();
bus.setMaxListeners(0);
function emitChange(kind, payload) {
  bus.emit("xtboard:change", { kind, ts: now(), payload: payload || null });
}
function on(fn) {
  bus.on("xtboard:change", fn);
  return () => bus.off("xtboard:change", fn);
}
function off(fn) {
  bus.off("xtboard:change", fn);
}

// ---- board state ----
function mkBoard(name) {
  return { id: newId("b_"), name, active: true, created: now() };
}

// Seeds default boards (features + bugs) on first run.
function loadBoard() {
  let b = loadJson(boardPath(), null);
  if (!b || typeof b !== "object" || typeof b.tasks !== "object" || b.tasks === null) {
    b = { version: 2, boards: [mkBoard("features"), mkBoard("bugs")], tasks: {} };
    saveJson(boardPath(), b);
    if (fs.existsSync(boardPath()) && !fs.existsSync(logPath())) glog("xtboard initialized with default boards: features, bugs");
    return b;
  }
  if (!b.version) b.version = 2;
  if (!Array.isArray(b.boards) || b.boards.length === 0) b.boards = [mkBoard("features"), mkBoard("bugs")];
  return b;
}

function envBy(defaultName) {
  const v = (process.env.XT_BY || "").trim();
  return v || defaultName || "cli";
}

//
// mutate: lock → load → capture pre-state → fn(board) → history diff
// (v1 shape: {ts,by,changes:[{field,from,to}]} incl. blocked_reason) →
// save atomic → global log line → emit change event.
//
function mutate(label, fn, opts = {}) {
  const by = opts.by || envBy();
  acquireLock();
  try {
    const board = loadBoard();
    const pre = {};
    for (const [tid, t] of Object.entries(board.tasks)) {
      pre[tid] = { status: t.status, note: t.note, blocked_reason: t.blocked_reason };
    }
    const result = fn(board);
    for (const [tid, t] of Object.entries(board.tasks)) {
      const p = pre[tid] || { status: t.status, note: t.note, blocked_reason: t.blocked_reason };
      const changes = [];
      if (t.status !== p.status) changes.push({ field: "status", from: p.status, to: t.status });
      if (t.note !== p.note && t.note) changes.push({ field: "note", from: "(updated)", to: t.note });
      if (t.blocked_reason !== p.blocked_reason) changes.push({ field: "blocked_reason", from: p.blocked_reason || "", to: t.blocked_reason });
      if (changes.length) {
        t.history = (t.history || []).concat({ ts: now(), by, changes });
        t.history = t.history.slice(-HISTORY_CAP);
      }
    }
    saveJson(boardPath(), board);
    glog(label);
    emitChange("state");
    return result;
  } finally {
    releaseLock();
  }
}

// ---- board (v1 group) ops ----
function findBoard(board, idOrName) {
  if (!idOrName) throw httpErr(400, "board id or name required");
  const want = String(idOrName);
  let b = board.boards.find((x) => x.id === want);
  if (!b) b = board.boards.find((x) => x.name.toLowerCase() === want.toLowerCase());
  if (!b) throw httpErr(404, `no board matching '${want}'`);
  return b;
}

function addBoardIn(board, name) {
  name = String(name || "").trim();
  if (!name) throw httpErr(400, "board name required");
  if (board.boards.some((x) => x.name.toLowerCase() === name.toLowerCase()))
    throw httpErr(409, `board '${name}' already exists`);
  const b = mkBoard(name);
  board.boards.push(b);
  return b;
}

function setBoardNameIn(board, idOrName, name) {
  name = String(name || "").trim();
  if (!name) throw httpErr(400, "board name required");
  const b = findBoard(board, idOrName);
  if (board.boards.some((x) => x.id !== b.id && x.name.toLowerCase() === name.toLowerCase()))
    throw httpErr(409, `board '${name}' already exists`);
  b.name = name;
  return b;
}

function setBoardActiveIn(board, idOrName, active) {
  const b = findBoard(board, idOrName);
  b.active = !!active;
  return b;
}

function removeBoardIn(board, idOrName) {
  const b = findBoard(board, idOrName);
  const stuck = Object.values(board.tasks).find((t) => t.board === b.id && t.status !== "done");
  if (stuck) throw httpErr(409, `board '${b.name}' still has a non-done task (${stuck.id}) — finish or reassign it first`);
  board.boards = board.boards.filter((x) => x.id !== b.id);
  return b;
}

// ---- task lookup / ops (pure on board; wrap in mutate) ----
// v1 id matching: exact, or t_<suffix>, or raw suffix (endswith).
function findTask(board, tid) {
  tid = String(tid || "");
  if (!tid) throw httpErr(400, "task id required");
  const norm = tid.startsWith("t_") ? tid : `t_${tid}`;
  let t = board.tasks[norm];
  if (!t) {
    for (const v of Object.values(board.tasks))
      if (v.id.endsWith(tid) || v.id === norm) {
        t = v;
        break;
      }
  }
  if (!t) throw httpErr(404, `no task matching ${tid}`);
  return t;
}

function normalizeTask(raw) {
  const t = raw || {};
  return {
    id: t.id,
    title: String(t.title || ""),
    owner: String(t.owner || "").replace(/^@/, ""),
    status: STATUSES.includes(t.status) ? t.status : "todo",
    note: t.note || "",
    claimed_by: t.claimed_by || null,
    fails: Number.isInteger(t.fails) ? t.fails : 0,
    last_error: t.last_error || null,
    created: t.created || now(),
    updated: t.updated || now(),
    history: Array.isArray(t.history) ? t.history.slice(-HISTORY_CAP) : [],
    // v2 fields
    board: t.board || null,
    blocked_reason: typeof t.blocked_reason === "string" ? t.blocked_reason : "",
    logs: (Array.isArray(t.logs) ? t.logs : []).slice(-LOGS_CAP),
    claimed_at: t.claimed_at || null,
    worker_pid: Number.isInteger(t.worker_pid) && t.worker_pid > 0 ? t.worker_pid : null,
  };
}

function boardOf(board, t) {
  const b = board.boards.find((x) => x.id === t.board);
  if (b) return b;
  return board.boards[0] || null;
}

function addTaskIn(board, { title, boardId, owner, status, note, blocked_reason }) {
  title = String(title || "").trim();
  if (!title) throw httpErr(400, "task title required");
  if (status == null) status = "todo";
  if (!["todo", "ready", "blocked"].includes(status)) throw httpErr(400, "initial status must be todo, ready, or blocked");
  const b = boardId ? findBoard(board, boardId) : board.boards[0];
  if (!b) throw httpErr(409, "no boards exist yet — create one first");
  const t = normalizeTask({
    id: newId("t_"),
    title,
    owner: owner || "xtranslator-architect",
    status,
    note: note || "",
    board: b.id,
    blocked_reason: status === "blocked" ? String(blocked_reason || "") : "",
  });
  board.tasks[t.id] = t;
  return t;
}

const ORCHESTRATORS = new Set(["pi", "web", "xtranslator-architect", "architect"]);

function claimIn(board, tid, worker, opts = {}) {
  const name = typeof worker === "string" ? worker : (worker && worker.name) || "pi";
  const pid = worker && typeof worker === "object" ? worker.pid : null;
  if (halted())
    throw httpErr(403, "orchestrator is HALTED — no new work may be claimed (resume to lift)");
  const t = findTask(board, tid);
  const b = boardOf(board, t);
  if (b && !b.active) throw httpErr(403, `board '${b.name}' is paused — resume the board before claiming`);
  if (t.status === "running" && t.claimed_by && t.claimed_by !== name)
    throw httpErr(403, `task ${t.id} already claimed by ${t.claimed_by}`);
  const owner = String(t.owner || "").trim().toLowerCase();
  const who = name.toLowerCase();
  if (owner && who !== owner && !opts.force && !ORCHESTRATORS.has(who)) {
    throw httpErr(
      403,
      `task ${t.id} is assigned to '${t.owner}' — claim by '${name}' refused (xtb: claim ID worker --force to override; web: send {"force":true})`
    );
  }
  t.status = "running";
  t.claimed_by = name;
  t.claimed_at = now();
  if (Number.isInteger(pid) && pid > 0) t.worker_pid = pid;
  t.updated = now();
  return t;
}

function releaseIn(board, tid) {
  const t = findTask(board, tid);
  t.status = "ready";
  t.claimed_by = null;
  t.claimed_at = null;
  t.updated = now();
  return t;
}

function failIn(board, tid, reason) {
  const t = findTask(board, tid);
  t.fails = (t.fails || 0) + 1;
  t.last_error = String(reason || "worker failed").slice(0, 500);
  t.status = "ready";
  t.claimed_by = null;
  t.claimed_at = null;
  t.updated = now();
  return t;
}

function doneIn(board, tid, note) {
  const t = findTask(board, tid);
  t.status = "done";
  t.claimed_by = null;
  t.claimed_at = null;
  t.updated = now();
  if (note) t.note = String(note);
  return t;
}

function blockIn(board, tid, reason, note) {
  const t = findTask(board, tid);
  t.status = "blocked";
  t.blocked_reason = String(reason || "");
  if (note != null) t.note = String(note);
  t.updated = now();
  return t;
}

function unblockIn(board, tid, note) {
  const t = findTask(board, tid);
  t.status = "ready";
  t.blocked_reason = "";
  if (note != null) t.note = String(note);
  t.updated = now();
  return t;
}

// v1 `move`: any status; clearing claim unless target is running.
function moveIn(board, tid, status, note) {
  if (!STATUSES.includes(status)) throw httpErr(400, `status must be one of: ${STATUSES.join("|")}`);
  const t = findTask(board, tid);
  t.status = status;
  if (status !== "running" && t.claimed_by) {
    t.claimed_by = null;
    t.claimed_at = null;
  }
  if (status !== "blocked") t.blocked_reason = "";
  if (note) t.note = String(note);
  t.updated = now();
  return t;
}

// Generic partial update (server PATCH /api/tasks/:id). Semantics follow the
// dedicated ops: status transitions clear the claim unless target is running
// (moveIn rule); blocked_reason is only cleared by leaving "blocked".
function patchTaskIn(board, tid, patch = {}) {
  const t = findTask(board, tid);
  if ("title" in patch) {
    const title = String(patch.title == null ? "" : patch.title).trim();
    if (!title) throw httpErr(400, "task title must not be empty");
    t.title = title;
  }
  if ("owner" in patch && patch.owner != null) t.owner = String(patch.owner).replace(/^@/, "");
  if ("note" in patch) t.note = String(patch.note == null ? "" : patch.note);
  if ("status" in patch) {
    if (!STATUSES.includes(patch.status)) throw httpErr(400, `status must be one of: ${STATUSES.join("|")}`);
    t.status = patch.status;
    if (patch.status !== "running" && t.claimed_by) {
      t.claimed_by = null;
      t.claimed_at = null;
    }
    if (patch.status !== "blocked") t.blocked_reason = "";
  }
  if ("blocked_reason" in patch) t.blocked_reason = String(patch.blocked_reason == null ? "" : patch.blocked_reason);
  if ("board" in patch && patch.board) {
    const b = findBoard(board, patch.board);
    t.board = b.id;
  }
  t.updated = now();
  return t;
}

function noteIn(board, tid, text) {
  const t = findTask(board, tid);
  t.note = String(text == null ? "" : text);
  t.updated = now();
  return t;
}

function logIn(board, tid, msg, by) {
  const t = findTask(board, tid);
  t.logs = t.logs || [];
  t.logs.push({ ts: now(), by: (by || envBy()).toString(), msg: String(msg == null ? "" : msg).slice(0, 500) });
  t.logs = t.logs.slice(-LOGS_CAP);
  t.updated = now();
  return t;
}

// Oldest `ready` task across ACTIVE boards, in board order (earliest board
// first; inside a board by created, then id). v1 has no boards, so this is the
// v2 generalization of "oldest ready task".
function pickNext(board, boardIdOrName, owner) {
  const boards = boardIdOrName ? [findBoard(board, boardIdOrName)] : board.boards;
  const want = owner ? String(owner).trim().toLowerCase() : "";
  for (const b of boards) {
    if (!b.active) continue;
    let ready = Object.values(board.tasks)
      .filter((t) => t.board === b.id && t.status === "ready")
      .sort((a, x) => (a.created < x.created ? -1 : a.created > x.created ? 1 : a.id < x.id ? -1 : 1));
    if (want) ready = ready.filter((t) => String(t.owner || "").trim().toLowerCase() === want);
    if (ready.length) return ready[0];
  }
  return null;
}

function countsIn(board, boardIdOrName) {
  const c = { todo: 0, ready: 0, running: 0, blocked: 0, done: 0 };
  const b = boardIdOrName ? findBoard(board, boardIdOrName) : null;
  for (const t of Object.values(board.tasks)) {
    if (b && t.board !== b.id) continue;
    c[t.status] = (c[t.status] || 0) + 1;
  }
  return c;
}

// ---- halt state ----
function halted() {
  return fs.existsSync(haltPath());
}
function haltInfo() {
  return halted() ? loadJson(haltPath(), {}) : null;
}

// ---- kill / revert / unload (v1 logic, Node port) ----
function killWorkerTree(extraRoots = []) {
  const ppid = new Map();
  for (const e of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(e)) continue;
    try {
      const st = fs.readFileSync(`/proc/${e}/stat`, "utf8");
      const rest = st.slice(st.lastIndexOf(")") + 1).trim().split(/\s+/);
      if (rest[1] != null) ppid.set(Number(e), Number(rest[1]));
    } catch { /* gone */ }
  }
  const roots = [...extraRoots];
  // v1 pattern: dispatched worker chains look like `timeout N pi -p ...`
  for (const p of ppid.keys()) {
    try {
      const cmd = fs.readFileSync(`/proc/${p}/cmdline`, "utf8").replace(/\0/g, " ");
      if (/timeout [0-9]+ pi -p/.test(cmd)) roots.push(p);
    } catch { /* gone */ }
  }
  const alive = roots.filter((p) => Number.isInteger(p) && p > 0 && fs.existsSync(`/proc/${p}`));
  if (!alive.length) return [];
  const all = new Set(alive);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [childPid, parent] of ppid)
      if (all.has(parent) && !all.has(childPid)) {
        all.add(childPid);
        grew = true;
      }
  }
  const pids = [...all].sort((a, b) => b - a);
  for (const p of pids) {
    try { process.kill(p, "SIGTERM"); } catch { /* ok */ }
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000); // v1: 8s grace
  for (const p of pids) {
    if (fs.existsSync(`/proc/${p}`)) {
      try { process.kill(p, "SIGKILL"); } catch { /* ok */ }
    }
  }
  return pids;
}

// Revert dirty repos under ~/Development/XTranslator (v1 logic verbatim).
// $XTBOARD_REV_BASE overrides the base dir (used by selftest so it never
// touches the real repos).
function revertDirtyRepos(baseOverride) {
  const base = baseOverride || process.env.XTBOARD_REV_BASE || path.join(os.homedir(), "Development", "XTranslator");
  const out = [];
  let entries = [];
  try {
    entries = fs.readdirSync(base).sort();
  } catch {
    return out;
  }
  const run = (args, timeout) => {
    try {
      return child.spawnSync("git", args, { timeout, stdio: "ignore" }).status === 0;
    } catch {
      return false;
    }
  };
  for (const d of entries) {
    const repo = path.join(base, d);
    let isRepo = false;
    try {
      isRepo = fs.statSync(path.join(repo, ".git")).isDirectory();
    } catch { /* skip */ }
    if (!isRepo) continue;
    let dirty = "";
    try {
      dirty = child.spawnSync("git", ["-C", repo, "status", "--porcelain"], { timeout: 30000 }).stdout.toString().trim();
    } catch {
      continue;
    }
    if (!dirty) continue;
    run(["-C", repo, "reset", "-q"], 30000);
    run(["-C", repo, "checkout", "--", "."], 60000);
    run(["-C", repo, "clean", "-fdq"], 60000);
    out.push(d);
  }
  return out;
}

// Offload the Ollama model (frees VRAM). Model name comes from
// ~/.pi/agent/settings.json (defaultModel); otherwise skip with a message.
function ollamaUnload() {
  let model = null;
  try {
    model = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "settings.json"), "utf8")).defaultModel || null;
  } catch { /* no settings */ }
  if (!model) return { skipped: true, message: "no defaultModel in ~/.pi/agent/settings.json — Ollama unload skipped" };
  let r;
  try {
    r = child.spawnSync("ollama", ["stop", model], { timeout: 60000, stdio: "pipe" });
  } catch (err) {
    return { model, error: String(err.message || err) };
  }
  return { model, rc: r.status, out: (r.stdout || Buffer.alloc(0)).toString().trim().slice(0, 80) };
}

function haltAction(opts = {}) {
  const mode = opts.mode === "kill" ? "kill" : "drain";
  const unload = !!opts.unload;
  const by = opts.by || envBy();
  glog(`HALT engaged (mode=${mode}, unload=${unload}) by=${by}`);
  let killed = [];
  let dirty = [];
  if (mode === "kill") {
    // v1: task's recorded worker_pid + ROOT/worker.pid + the pi -p scan.
    let taskPids = [];
    try {
      const b = loadBoard();
      taskPids = Object.values(b.tasks)
        .filter((t) => t.status === "running" && Number.isInteger(t.worker_pid))
        .map((t) => t.worker_pid);
    } catch { /* no tasks */ }
    let filePid = null;
    try {
      const v = parseInt(fs.readFileSync(path.join(homedirRoot(), "worker.pid"), "utf8").trim(), 10);
      if (Number.isFinite(v)) filePid = v;
    } catch { /* none */ }
    killed = killWorkerTree(filePid == null ? taskPids : [filePid, ...taskPids]);
    dirty = revertDirtyRepos();
    glog(`halt --kill: killed pids=${JSON.stringify(killed)} reverted repos=${dirty.length ? dirty.join(",") : "none"}`);
  }
  let unloadRes = null;
  if (unload) {
    unloadRes = ollamaUnload();
    glog(`halt --unload: ${unloadRes.skipped ? unloadRes.message : `ollama stop ${unloadRes.model} rc=${unloadRes.rc} ${unloadRes.out || ""}`}`);
  }
  let marked = [];
  if (mode === "kill") {
    marked = mutate("halt --kill: marked running task(s) as failed", (b) => {
      const done = [];
      for (const t of Object.values(b.tasks)) {
        if (t.status !== "running") continue;
        t.fails = (t.fails || 0) + 1;
        t.last_error = String((t.last_error || "").slice(0, 400) + ` :: halted(--kill) ${now()}`).slice(0, 500);
        t.status = "ready";
        t.claimed_by = null;
        t.claimed_at = null;
        t.updated = now();
        done.push(t.id);
      }
      return done;
    }, { by });
  }
  const info = {
    ts: now(),
    mode,
    unloaded: unload,
    killed,
    marked,
    reverted: dirty,
    by,
    ...(unloadRes ? { unload_res: unloadRes } : {}),
  };
  saveJson(haltPath(), info);
  emitChange("halt");
  return info;
}

function resumeAction(opts = {}) {
  const by = opts.by || envBy();
  if (!halted()) return { already_active: true };
  const prev = loadJson(haltPath(), {});
  try {
    fs.rmSync(haltPath(), { force: true });
  } catch { /* fine */ }
  glog(`HALT lifted (was: ${prev.ts || "?"} mode=${prev.mode || "?"}) by=${by}`);
  emitChange("halt");
  return { resumed_from: prev };
}

// ---- runs (v1 `xt run` / `xt runs`) ----
function addRun(job, status, detail, by) {
  if (!job) throw httpErr(400, "job name required");
  if (!["ok", "fail"].includes(status)) throw httpErr(400, "run status must be ok or fail");
  acquireLock();
  try {
    const runs = loadJson(runsPath(), []);
    runs.unshift({ job: String(job), status, detail: String(detail || "").slice(0, 500), at: now() });
    saveJson(runsPath(), runs.slice(0, RUNS_CAP));
    glog(`job-run ${job}: ${status} ${String(detail || "").slice(0, 120)}`);
    emitChange("runs");
    return { job: String(job), status, by: by || envBy() };
  } finally {
    releaseLock();
  }
}
function readRuns(n = 15) {
  return loadJson(runsPath(), []).slice(0, Math.max(1, n | 0));
}

// ---- v1 → v2 import ----
function importFile(file, opts = {}) {
  const raw = loadJson(file, null);
  if (!raw || typeof raw.tasks !== "object" || raw.tasks === null)
    throw httpErr(400, `${file}: not a v1/v2 board.json (no tasks object)`);
  const targetName = opts.targetBoard || "features";
  const result = mutate(`import: ${opts.by ? `by=${opts.by} ` : ""}file=${path.basename(file)}`, (b) => {
    let target = b.boards.find((x) => x.name.toLowerCase() === targetName.toLowerCase());
    if (!target) {
      target = mkBoard(targetName);
      b.boards.unshift(target);
    }
    let added = 0;
    let kept = 0;
    for (const [id, rawTask] of Object.entries(raw.tasks)) {
      if (b.tasks[id]) {
        kept++;
        continue;
      }
      const t = normalizeTask({ ...rawTask, id });
      t.board = target.id;
      b.tasks[id] = t;
      added++;
    }
    return { added, kept, target: target.id, targetName: target.name };
  }, { by: opts.by || envBy("import") });
  return result;
}

// ---- one-shot state snapshot (server /api/state shape) ----
function state() {
  const board = loadBoard();
  return {
    version: board.version || 2,
    boards: board.boards,
    tasks: board.tasks,
    halted: haltInfo(),
    counts: countsIn(board),
    runs: readRuns(50),
    feed: feed(50),
    server_ts: now(),
  };
}

module.exports = {
  STATUSES,
  LOGS_CAP,
  HISTORY_CAP,
  RUNS_CAP,
  homedirRoot,
  boardPath,
  haltPath,
  runsPath,
  logPath,
  lockPath,
  now,
  newId,
  glog,
  feed,
  loadBoard,
  mutate,
  findBoard,
  addBoardIn,
  setBoardActiveIn,
  setBoardNameIn,
  removeBoardIn,
  findTask,
  normalizeTask,
  addTaskIn,
  claimIn,
  releaseIn,
  failIn,
  doneIn,
  blockIn,
  unblockIn,
  moveIn,
  patchTaskIn,
  noteIn,
  logIn,
  pickNext,
  countsIn,
  halted,
  haltInfo,
  haltAction,
  resumeAction,
  killWorkerTree,
  revertDirtyRepos,
  ollamaUnload,
  addRun,
  readRuns,
  importFile,
  state,
  on,
  off,
};
