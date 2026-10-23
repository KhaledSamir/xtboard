#!/usr/bin/env node
"use strict";
/*
 * xtboard selftest — run: node selftest.js
 *
 * Covers the master brief's selftest list:
 *   add/list/claim/release/fail/done history counts; double-claim refusal;
 *   paused board refuses claim; global halt refuses claim → resume restores;
 *   block/unblock stores reason; `next` ordering across boards (inactive
 *   board skipped); import of the real v1 board.json (123 tasks, 2 blocked,
 *   lands on `features`); logs cap; runs add/list; xtb CLI add/list (and the
 *   rest of the CLI surface) via child processes; clear refusal message texts.
 *   Plus: board rename/patch/remove rules, task patch, halt --kill on a fake
 *   running task (dead pid, XTBOARD_REV_BASE pointed at an empty dir so no
 *   real process/repo is ever touched).
 *
 * Prints PASS/FAIL per case + summary; exits non-zero on any failure.
 * Every case runs in a fresh tmp XTBOARD_HOME (never ~/.pi/xtboard, never
 * the real ~/Development/XTranslator repos).
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = __dirname;
const core = require(path.join(ROOT, "core.js"));
const V1_BOARD = "/home/homeadmin/backups/orchestrator-archive-20261023/board.json";
const WEB = "selftest";

let pass = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`FAIL  ${name}\n      ${String(err.message || err).split("\n")[0]}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}
function assertEq(a, b, label) {
  const ja = JSON.stringify(a);
  const jb = JSON.stringify(b);
  assert(ja === jb, `${label}: expected ${jb}, got ${ja}`);
}
function assertIn(s, substr, label) {
  assert(typeof s === "string" && s.includes(substr), `${label || "text"}: missing ${JSON.stringify(substr)} in ${JSON.stringify(String(s).slice(0, 200))}`);
}
function expectErr(fn, re, label) {
  try {
    fn();
  } catch (err) {
    assert(String(err.message).search(re) !== -1, `${label}: /${re}/ not matched by: ${JSON.stringify(String(err.message))}`);
    return err;
  }
  throw new Error(`${label}: expected error matching /${re}/, none thrown`);
}
function newHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "xtboard-selftest-"));
}
function cli(home, args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [path.join(ROOT, "xtb"), ...args], {
    encoding: "utf8",
    env: { ...(process.env || {}), XTBOARD_HOME: home, XT_BY: WEB, XT_WORKER: "selftest", ...extraEnv },
  });
  return { code: r.status, out: `${r.stdout || ""}${r.stderr || ""}` };
}
function findTaskId(home, reTitle) {
  const b = core.loadBoard();
  const t = Object.values(b.tasks).find((x) => reTitle.test(x.title));
  return t ? t.id : null;
}

// ================= home A: lifecycle, refusals, caps, runs =================
const homeA = newHome();
process.env.XTBOARD_HOME = homeA;

test("A1 default boards seeded on first run (features + bugs, active, v2)", () => {
  const b = core.loadBoard();
  assertEq(b.version, 2, "version");
  assertEq(b.boards.length, 2, "board count");
  assertEq(b.boards.map((x) => x.name), ["features", "bugs"], "board names");
  assert(b.boards.every((x) => x.active === true), "all boards active");
  assert(b.boards.every((x) => x.id.startsWith("b_")), "board ids b_<hex>");
});

let lifecycle; // { id, boardId }
test("A2 add: task lands on first board with sane defaults + no history yet (v1 add rule)", () => {
  const t = core.mutate(`task added: lifecycle (owner=w1, board=default, status=ready)`, (b) =>
    core.addTaskIn(b, { title: "lifecycle task", owner: "w1", status: "ready" })
  );
  const b = core.loadBoard();
  assertEq(t.status, "ready", "status");
  assertEq(t.owner, "w1", "owner");
  assertEq(t.board, b.boards[0].id, "board is first board");
  assertEq(t.fails, 0, "fails");
  assertEq((t.history || []).length, 0, "history after add (v1: add records no history)");
  lifecycle = { id: t.id, boardId: b.boards[0].id };
});

test("A3 xtb CLI add/list against the same home (runs add/list)", () => {
  const r1 = cli(homeA, ["add", "cli task A", "--owner", "wcli", "--status", "ready"]);
  assertEq(r1.code, 0, "xtb add exit");
  assertIn(r1.out, "cli task A", "xtb add output");
  const r2 = cli(homeA, ["list"]);
  assertEq(r2.code, 0, "xtb list exit");
  assertIn(r2.out, "cli task A", "xtb list shows cli task A");
  assertIn(r2.out, "lifecycle task", "xtb list shows lifecycle task");
  const r3 = cli(homeA, ["boards"]);
  assertEq(r3.code, 0, "xtb boards exit");
  assertIn(r3.out, '"version": 2', "xtb boards json");
});

test("A4 claim by w1: running + claimed_by + history entry #1 (ready→running)", () => {
  const t = core.mutate(`task ${lifecycle.id} claimed by w1`, (b) => core.claimIn(b, lifecycle.id, "w1"), { by: "w1" });
  assertEq(t.status, "running", "status");
  assertEq(t.claimed_by, "w1", "claimed_by");
  assert(t.claimed_at, "claimed_at set");
  const b = core.loadBoard();
  const h = b.tasks[lifecycle.id].history;
  assertEq(h.length, 1, "history length");
  assertEq(h[0].changes, [{ field: "status", from: "ready", to: "running" }], "history change");
  assertEq(h[0].by, "w1", "history actor");
});

test("A5 double-claim refusal: w2 (even forced) refused while w1 holds the claim, message names w1; w1 may re-claim", () => {
  expectErr(
    () => core.mutate("double claim", (b) => core.claimIn(b, lifecycle.id, "w2", { force: true })),
    /already claimed by w1/,
    "double-claim 403"
  );
  const t = core.mutate("re-claim by w1", (b) => core.claimIn(b, lifecycle.id, "w1"), { by: "w1" });
  assertEq(t.status, "running", "still running");
  const b = core.loadBoard();
  assertEq(b.tasks[lifecycle.id].history.length, 1, "no new history for same-winner re-claim");
});

test("A6 release: back to ready, claim cleared, history entry #2", () => {
  const t = core.mutate("released", (b) => core.releaseIn(b, lifecycle.id));
  assertEq(t.status, "ready", "status");
  assertEq(t.claimed_by, null, "claimed_by");
  const b = core.loadBoard();
  const h = b.tasks[lifecycle.id].history;
  assertEq(h.length, 2, "history length");
  assertEq(h[1].changes, [{ field: "status", from: "running", to: "ready" }], "change");
});

test("A7 fail: fails=1 + last_error, status stays ready (v1: no status change, no history entry)", () => {
  const t = core.mutate("failed: boom", (b) => core.failIn(b, lifecycle.id, "boom: disk full"));
  assertEq(t.fails, 1, "fails");
  assertIn(t.last_error, "boom: disk full", "last_error");
  assertEq(t.status, "ready", "status");
  const b = core.loadBoard();
  assertEq(b.tasks[lifecycle.id].history.length, 2, "history unchanged (no status change)");
});

test("A8 done: history entry #3 (ready→done); history shape {ts,by,changes} throughout", () => {
  const t = core.mutate("done", (b) => core.doneIn(b, lifecycle.id, "shipped"));
  assertEq(t.status, "done", "status");
  const b = core.loadBoard();
  const h = b.tasks[lifecycle.id].history;
  assertEq(h.length, 3, "history length");
  for (const e of h) {
    assert(typeof e.ts === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(e.ts), "history ts format");
    assert(typeof e.by === "string", "history by");
    assert(Array.isArray(e.changes), "history changes array");
  }
  const last = h[2].changes;
  assertEq(last[0], { field: "status", from: "ready", to: "done" }, "final status change");
  assertEq(last[last.length - 1], { field: "note", from: "(updated)", to: "shipped" }, "done-note recorded");
});

test("A9 block/unblock stores reason; history records blocked_reason changes", () => {
  const t0 = core.mutate("add t9", (b) => core.addTaskIn(b, { title: "block me", status: "ready", owner: "w2" }));
  const t = core.mutate("blocked: waiting on API", (b) => core.blockIn(b, t0.id, "waiting on upstream API"));
  assertEq(t.status, "blocked", "status");
  assertEq(t.blocked_reason, "waiting on upstream API", "blocked_reason stored");
  let b = core.loadBoard();
  const h1 = b.tasks[t0.id].history;
  assert(h1.some((e) => e.changes.some((c) => c.field === "blocked_reason" && c.to === "waiting on upstream API")), "history has blocked_reason change");
  const u = core.mutate("unblocked", (b2) => core.unblockIn(b2, t0.id));
  assertEq(u.status, "ready", "status ready");
  assertEq(u.blocked_reason, "", "reason cleared");
  b = core.loadBoard();
  assertEq(b.tasks[t0.id].history.length, 2, "two history entries (block, unblock)");
});

test("A10 paused board refuses claim, message names the board; resume restores claims", () => {
  const b0 = core.loadBoard();
  const bugs = b0.boards.find((x) => x.name === "bugs");
  const t = core.mutate("add t10", (b) => core.addTaskIn(b, { title: "on paused board", status: "ready", boardId: bugs.id, owner: "w1" }));
  core.mutate("board paused: bugs", (b) => core.setBoardActiveIn(b, bugs.id, false));
  expectErr(() => core.mutate("claim refused", (b) => core.claimIn(b, t.id, "w1")), /board 'bugs'.*paused/i, "paused-board 403");
  core.mutate("board resumed: bugs", (b) => core.setBoardActiveIn(b, bugs.id, true));
  const ok = core.mutate("claim ok", (b) => core.claimIn(b, t.id, "w1"), { by: "w1" });
  assertEq(ok.status, "running", "claim succeeded after resume");
  core.mutate("cleanup: release", (b) => core.releaseIn(b, t.id));
  // CLI surface too
  cli(homeA, ["board", "pause", "bugs"]);
  expectErr(() => core.mutate("cli-paused claim refused", (b) => core.claimIn(b, t.id, "w2")), /paused/, "paused via CLI");
  const rr = cli(homeA, ["board", "resume", "bugs"]);
  assertEq(rr.code, 0, "xtb board resume exit");
  assertIn(rr.out, "RESUMED", "resume message");
});

test("A11 global halt refuses claim (message says HALT + resume); resume restores; `next` also refused while halted", () => {
  const t0 = core.mutate("add t11", (b) => core.addTaskIn(b, { title: "halt me", status: "ready", owner: "w1" }));
  const info = core.haltAction({ mode: "drain", by: WEB });
  assertEq(info.mode, "drain", "mode");
  assert(core.halted(), "halt.json present");
  expectErr(() => core.mutate("claim during halt", (b) => core.claimIn(b, t0.id, "w1")), /HALT.*resume/ , "halt 403");
  const nx = cli(homeA, ["next"]);
  assert(nx.code !== 0, "xtb next exits non-zero while halted");
  assertIn(nx.out, "HALT", "xtb next refusal mentions HALT");
  const res = core.resumeAction({ by: WEB });
  assert(!res.already_active, "resume reports it was halted");
  const ok = core.mutate("claim after resume", (b) => core.claimIn(b, t0.id, "w1"), { by: "w1" });
  assertEq(ok.status, "running", "claim ok after resume");
  core.mutate("cleanup: done", (b) => core.doneIn(b, t0.id));
});

test("A12 logs cap at 200, newest kept in order", () => {
  const t0 = core.mutate("add t12", (b) => core.addTaskIn(b, { title: "log cap", status: "todo", owner: "w2" }));
  core.mutate("210 log lines", (b) => {
    for (let i = 1; i <= 210; i++) core.logIn(b, t0.id, `m${i}`, WEB);
    return null;
  }, { by: WEB });
  const b = core.loadBoard();
  const logs = b.tasks[t0.id].logs;
  assertEq(logs.length, 200, "cap 200");
  assertEq(logs[0].msg, "m11", "oldest dropped");
  assertEq(logs[logs.length - 1].msg, "m210", "newest kept");
  assertEq(logs[0].by, WEB, "log by");
});

test("A13 runs: add + list newest-first, cap respected, persisted to runs.json", () => {
  core.addRun("job-a", "ok", "first", { by: WEB });
  core.addRun("job-b", "fail", "second", { by: WEB });
  core.addRun("job-c", "ok", "third", { by: WEB });
  const two = core.readRuns(2);
  assertEq(two.length, 2, "n honored");
  assertEq(two.map((r) => r.job), ["job-c", "job-b"], "newest first");
  const all = core.readRuns(50);
  assertEq(all.length, 3, "three runs");
  const file = JSON.parse(fs.readFileSync(path.join(homeA, "runs.json"), "utf8"));
  assertEq(file.length, 3, "runs.json persisted");
  assertEq(file[0].job, "job-c", "file newest first");
});

test("A14 clear refusal message texts (not-found / not-found board / dup board / non-done delete)", () => {
  expectErr(() => core.mutate("nope", (b) => core.findTask(b, "does-not-exist-xyz")), /no task matching/, "task 404 text");
  expectErr(() => core.mutate("nope", (b) => core.setBoardActiveIn(b, "no-such-board", true)), /no board matching/, "board 404 text");
  expectErr(() => core.mutate("dup", (b) => core.addBoardIn(b, "features")), /already exists/, "dup board 409 text");
  const bd = core.mutate("scratch board", (b) => core.addBoardIn(b, "scratch"));
  const t = core.mutate("scratch task", (b) => core.addTaskIn(b, { title: "scratch", status: "todo", boardId: bd.id }));
  expectErr(() => core.mutate("delete with task", (b) => core.removeBoardIn(b, "scratch")), /still has a non-done task/, "delete refusal text");
  core.mutate("scratch task done", (b) => core.doneIn(b, t.id));
  const rm = core.mutate("delete scratch", (b) => core.removeBoardIn(b, "scratch"));
  assertEq(rm.name, "scratch", "removed after tasks done");
});

test("A15 board rename via core.setBoardNameIn + dup refusal; task patch via core.patchTaskIn", () => {
  const bd = core.mutate("patch board name", (b) => core.setBoardNameIn(b, core.loadBoard().boards[0].id, "FEATURES"));
  assertEq(bd.name, "FEATURES", "renamed");
  expectErr(() => core.mutate("dup rename", (b) => core.setBoardNameIn(b, "FEATURES", "bugs")), /already exists/, "dup rename 409");
  core.mutate("board name back", (b) => core.setBoardNameIn(b, "FEATURES", "features"));
  const t0 = core.mutate("patch target", (b) => core.addTaskIn(b, { title: "patch me", status: "todo", owner: "x", note: "" }));
  const t = core.mutate("patch task", (b) =>
    core.patchTaskIn(b, t0.id, { owner: "w2", note: "new note", status: "blocked", blocked_reason: "pending user", board: "bugs" })
  );
  assertEq(t.owner, "w2", "owner");
  assertEq(t.note, "new note", "note");
  assertEq(t.status, "blocked", "status");
  assertEq(t.blocked_reason, "pending user", "reason applied in same patch");
  const b2 = core.loadBoard();
  assertEq(t.board, b2.boards.find((x) => x.name === "bugs").id, "board moved");
  expectErr(() => core.mutate("bad patch", (b) => core.patchTaskIn(b, t.id, { status: "bogus" })), /status must be one of/, "bad status 400");
});

test("A16 global log: every mutation appended, [ts] msg format, feed() newest-first", () => {
  const raw = fs.readFileSync(path.join(homeA, "xtboard.log"), "utf8");
  const lines = raw.split("\n").filter(Boolean);
  assert(lines.length >= 10, `has log lines (${lines.length})`);
  for (const l of lines) assert(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] /.test(l), `line format: ${l}`);
  const feed = core.feed(5);
  assertEq(feed.length, 5, "feed n");
  assert(feed[0].ts >= feed[4].ts, "feed newest first");
});

// ================= home B: next() ordering across boards =================
const homeB = newHome();
process.env.XTBOARD_HOME = homeB;

test("B1 next() picks earliest board's ready task; skips it while paused (board1 inactive → board2)", () => {
  const b0 = core.loadBoard();
  const b1 = b0.boards[0]; // features
  const b2 = b0.boards[1]; // bugs
  const tf = core.mutate("add ready on b1", (b) => core.addTaskIn(b, { title: "b1 ready", status: "ready", boardId: b1.id, owner: "w2" }));
  const tb = core.mutate("add ready on b2", (b) => core.addTaskIn(b, { title: "b2 ready", status: "ready", boardId: b2.id, owner: "w2" }));
  const n1 = core.mutate("next (noop)", (b) => core.pickNext(b));
  assertEq(n1.id, tf.id, "b1 task first (board order)");
  core.mutate("pause b1", (b) => core.setBoardActiveIn(b, b1.id, false));
  const n2 = core.mutate("next (b1 paused)", (b) => core.pickNext(b));
  assertEq(n2.id, tb.id, "inactive board skipped → b2 task");
  core.mutate("resume b1", (b) => core.setBoardActiveIn(b, b1.id, true));
  // CLI: next + next --claim
  const rn = cli(homeB, ["next"]);
  assertEq(rn.code, 0, "xtb next exit");
  assertIn(rn.out, tf.id, "xtb next shows b1 task id");
  const rc = cli(homeB, ["next", "--claim", "w2"]);
  assertEq(rc.code, 0, "xtb next --claim exit");
  const claimed = JSON.parse(rc.out.split("\n")[0]);
  assertEq(claimed.id, tf.id, "claimed the b1 task");
  assertEq(claimed.status, "running", "now running");
  assertEq(claimed.claimed_by, "w2", "claimed_by");
});

// ================= home C: import of the real v1 board =================
const homeC = newHome();
process.env.XTBOARD_HOME = homeC;

test("C1 import real v1 board.json: 123 tasks, 2 blocked, 121 done, all on `features`", () => {
  const res = core.importFile(V1_BOARD, { by: WEB });
  assertEq(res.added, 123, "added");
  assertEq(res.kept, 0, "kept");
  assertEq(res.targetName, "features", "target board");
  const b = core.loadBoard();
  assertEq(b.version, 2, "v2");
  const feats = b.boards.find((x) => x.name === "features");
  const onFeatures = Object.values(b.tasks).filter((t) => t.board === feats.id);
  assertEq(onFeatures.length, 123, "tasks on features");
  const c = core.countsIn(b, "features");
  assertEq(c.blocked, 2, "blocked");
  assertEq(c.done, 121, "done");
  // blocked tasks keep their v1 note/last_error
  const blockedOnes = onFeatures.filter((t) => t.status === "blocked");
  assert(blockedOnes.every((t) => typeof t.note === "string"), "v1 fields preserved");
});

test("C2 xtb CLI import on a fresh home reports counts and board", () => {
  const homeC2 = newHome();
  const r = cli(homeC2, ["import", V1_BOARD]);
  assertEq(r.code, 0, "xtb import exit");
  assertIn(r.out, "imported 123 task(s)", "summary line");
  assertIn(r.out, "features", "target board name");
  const rb = cli(homeC2, ["counts", "--board", "features"]);
  assertEq(rb.code, 0, "xtb counts exit");
  const counts = JSON.parse(rb.out.trim());
  assertEq(counts.blocked, 2, "blocked count");
  assertEq(counts.done, 121, "done count");
  fs.rmSync(homeC2, { recursive: true, force: true });
});

// ================= home A (again): full CLI lifecycle incl. positional note =================
process.env.XTBOARD_HOME = homeA;

test("D1 xtb CLI end-to-end: add → claim → log → note(positional) → fail → done → show history → counts → runs", () => {
  const r0 = cli(homeA, ["add", "cli lifecycle", "--owner", "w3", "--status", "ready"]);
  assertEq(r0.code, 0, "add");
  const id = findTaskId(homeA, /cli lifecycle/);
  assert(id, "task visible in state");
  let r = cli(homeA, ["claim", id, "wcli"]);
  assert(r.code !== 0, "cross-pool claim refused (owner=w3, claimer=wcli)");
  assertIn(r.out + r.err, "assigned to 'w3'", "refusal names the owner");
  r = cli(homeA, ["claim", id, "wcli", "--force"]);
  assertEq(r.code, 0, "claim --force exit");
  assertIn(r.out, "running", "claim out");
  assertIn(r.out, "wcli", "worker shown");
  r = cli(homeA, ["log", id, "hello from cli"]);
  assertEq(r.code, 0, "log exit");
  assertIn(r.out, "logged on", "log out");
  r = cli(homeA, ["note", id, "positional note text"]);
  assertEq(r.code, 0, "note (positional) exit");
  assertIn(r.out, "positional note text", "note out");
  r = cli(homeA, ["show", id]);
  assertEq(r.code, 0, "show exit");
  assertIn(r.out, "history", "show history section");
  assertIn(r.out, "ready → running", "ready→running in history");
  r = cli(homeA, ["fail", id, "cli said fail"]);
  assertEq(r.code, 0, "fail exit");
  assertIn(r.out, "⚠ 1 fail(s)", "fails shown");
  r = cli(homeA, ["done", id, "wrapped"]);
  assertEq(r.code, 0, "done exit");
  assertIn(r.out, "done", "done shown");
  r = cli(homeA, ["counts"]);
  assertEq(r.code, 0, "counts exit");
  const counts = JSON.parse(r.out.trim());
  assert(typeof counts.done === "number" && counts.done >= 2, "counts sane");
  r = cli(homeA, ["runs"]);
  assertEq(r.code, 0, "runs exit");
  assertIn(r.out, "job-c", "runs list shows job-c");
});

// ================= home E: halt --kill on a fake running task (dead pid) =================
const homeE = newHome();
const revBase = newHome();
process.env.XTBOARD_HOME = homeE;
process.env.XTBOARD_REV_BASE = revBase;

test("E1 halt --kill on a fake running task (dead worker pid): marked failed, no real kill, CLI output clean", () => {
  const ghost = 99999999;
  assert(!fs.existsSync(`/proc/${ghost}`), "ghost pid genuinely dead");
  const t0 = core.mutate("add fake running", (b) => core.addTaskIn(b, { title: "fake worker task", status: "ready", owner: "ghost" }));
  core.mutate("claim ghost", (b) => core.claimIn(b, t0.id, { name: "ghost", pid: ghost }), { by: "ghost" });
  const haltInfo = core.haltAction({ mode: "kill", by: WEB });
  assertEq(haltInfo.mode, "kill", "mode kill");
  let b = core.loadBoard();
  let t = b.tasks[t0.id];
  assertEq(t.status, "ready", "marked back to ready");
  assertEq(t.fails, 1, "fail counted");
  assertIn(String(t.last_error), "halted(--kill)", "last_error notes the halt");
  assertEq(t.claimed_by, null, "claim cleared");
  const rr = core.resumeAction({ by: WEB });
  assert(!rr.already_active, "resume ok");
  // CLI variant: fresh running task, then `xtb halt --kill` (output must not contain 'undefined')
  const t1 = core.mutate("add fake running 2", (bb) => core.addTaskIn(bb, { title: "fake worker task 2", status: "ready", owner: "ghost" }));
  core.mutate("claim ghost 2", (bb) => core.claimIn(bb, t1.id, { name: "ghost", pid: ghost }), { by: "ghost" });
  const r = cli(homeE, ["halt", "--kill"]);
  assertEq(r.code, 0, "xtb halt --kill exit");
  assert(!/undefined/.test(r.out), `no stray 'undefined' in output: ${JSON.stringify(r.out.slice(0, 200))}`);
  assertIn(r.out, "ORCHESTRATOR PAUSED (mode=kill)", "pause banner");
  assertIn(r.out, "1 running task(s) marked failed", "failed-mark line");
  b = core.loadBoard();
  assertEq(b.tasks[t1.id].fails, 1, "task 2 failed");
  core.resumeAction({ by: WEB });
});

// ================= F: owner assignment enforcement =================
test("F1 owner enforcement: cross-pool claim refused; owner, orchestrator (web), and --force all allowed", () => {
  const t = core.mutate("add owner task", (b) => core.addTaskIn(b, { title: "owner enforced", status: "ready", owner: "alpha" }));
  let refused = false;
  try { core.claimIn(core.loadBoard(), t.id, { name: "beta" }); } catch (e) { refused = /assigned to 'alpha'/.test(String(e.message)); }
  assert(refused, "beta refused with owner named");
  core.mutate("claim as owner", (b) => core.claimIn(b, t.id, { name: "alpha" }));
  core.mutate("release", (b) => core.releaseIn(b, t.id));
  core.mutate("claim as orchestrator web", (b) => core.claimIn(b, t.id, { name: "web" }));
  core.mutate("release 2", (b) => core.releaseIn(b, t.id));
  core.mutate("claim forced", (b) => core.claimIn(b, t.id, { name: "gamma" }, { force: true }));
  assertEq(core.loadBoard().tasks[t.id].claimed_by, "gamma", "forced claim recorded");
});

test("F2 pickNext honors --owner filter and unassigned tasks are not picked for a named pool", () => {
  const a = core.mutate("add a", (b) => core.addTaskIn(b, { title: "aa", status: "ready", owner: "alpha" }));
  core.mutate("add c", (b) => core.addTaskIn(b, { title: "cc", status: "ready", owner: "alpha" }));
  const z = core.mutate("add z", (b) => core.addTaskIn(b, { title: "zz", status: "ready", owner: "zeta" }));
  core.mutate("add unassigned", (b) => core.addTaskIn(b, { title: "uu", status: "ready", owner: "" }));
  const bA = core.loadBoard();
  const oldestOf = (who) =>
    Object.values(bA.tasks)
      .filter((t) => t.status === "ready" && String(t.owner || "").trim().toLowerCase() === who)
      .sort((x, y) => (x.created < y.created ? -1 : x.created > y.created ? 1 : x.id < y.id ? -1 : 1))[0] || null;
  const firstAlpha = oldestOf("alpha");
  assertEq(core.pickNext(bA, undefined, "zeta").id, oldestOf("zeta").id, "pool zeta gets only zeta tasks (oldest first)");
  assertEq(core.pickNext(bA, undefined, "alpha").id, firstAlpha.id, "pool alpha gets alpha tasks only, oldest first (not zeta/unassigned)");
  assertEq(core.pickNext(bA, undefined, "nobody"), null, "no tasks for pool nobody");
  const n = core.pickNext(bA, undefined);
  assert(n, "unfiltered pick still works");
  assert(String(n.owner || "").toLowerCase() !== "zeta" || n.id === oldestOf("zeta").id, "unfiltered result is a sane ready task");
});

// ================= summary =================
const total = pass + failures.length;
console.log(`\n${pass}/${total} selftest cases passed.`);
if (failures.length) {
  console.log("FAILED CASES:");
  for (const f of failures) console.log(`  - ${f.name}: ${f.err.message}`);
  process.exitCode = 1;
} else {
  console.log("ALL PASS");
}

// cleanup temp homes
for (const h of [homeA, homeB, homeC, homeE, revBase]) {
  try { fs.rmSync(h, { recursive: true, force: true }); } catch { /* fine */ }
}
