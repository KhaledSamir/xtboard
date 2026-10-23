# w3 (UI chunk C) — xtboard index.html — 2026-10-23 16:10 UTC

## Status: COMPLETE within 15-min timebox

## Deliverable
- /home/homeadmin/Development/xtboard/index.html — 823 lines, 32,978 bytes.
  Single file, inline CSS+JS, zero external assets (verified). Replaces the
  placeholder; server.js serveUi() reads it per request (no restart needed).

## Verification evidence

### 1. No external URLs (grep)
    $ grep -nE "https?://" index.html        → exit 1 (no matches) ✅
    $ grep -nEi "src=|href=|cdn|@import|url\(" index.html | grep -v JS  → exit 1 (no matches) ✅

### 2. JS syntax check (extracted <script> → /tmp/ui.js, 561 lines)
    $ node --check /tmp/ui.js                → "SYNTAX OK" ✅

### 3. Serve check (throwaway instance, XTBOARD_HOME=$(mktemp -d), :9119)
    $ curl -s http://127.0.0.1:9119/ | head -c 300
      → returns MY html (<!doctype>… :root --bg:#121212 …), NOT the placeholder ✅
    $ curl -s -o /dev/null -w "%{http_code} %{size_download}B" → 200 32978B ✅
    $ curl -s / | grep -c "EMERGENCY KILL"  → 3 ✅
    $ /api/healthz → {"status":"ok","ts":"2026-10-23 16:08:31","halted":false} ✅
    $ /api/state keys → [version, boards, tasks, halted, counts, runs, feed, server_ts] — matches UI exactly ✅
    Board shape confirmed live: {id:"b_0dc343", name:"features", active:true, created:"…"} ✅
    Throwaway server killed; port 9119 free; no stray node server.js (verified via ps/ss).

## API shapes adapted (exact field names, cross-checked vs core.js/server.js)
- state.halted = null | {ts, mode, by, …} → banner uses h.mode/h.by/h.ts
- feed = state.feed = [{ts, msg}] (newest first) → right rail
- tasks = OBJECT map key t_xxx → values {id,title,owner,status,note,blocked_reason,
  claimed_by,claimed_at,worker_pid,fails,last_error,created,updated,history,logs[{ts,by,msg}],board}
- history item = {ts, by, changes:[{field,from,to}]}
- add board body {name}; patch board body {active:bool}; add task body
  {title, board, owner, note, status(todo|ready|blocked), blocked_reason}
- actions body: claim {worker}, fail {reason}, done/unblock {note}, block {reason}
- halt {mode:"drain"|"kill", unload} — kill sends unload:true per brief

## Feature checklist (brief spec → implementation)
- top bar: app name xtboard, halt banner (mode/by/ts), ⏸ PAUSE ALL (drain),
  ☢ EMERGENCY KILL (confirm → kill+unload), ▶ RESUME — implemented ✅
- board tabs: one per board, ACTIVE/PAUSED clickable pill (PATCH {active}),
  per-board counts (total + running/blocked), + New board (prompt) — ✅
- kanban columns READY/RUNNING/BLOCKED/TODO/DONE w/ counts; BLOCKED cards
  show ❗ + blocked_reason; RUNNING cards show live ⏱ elapsed (1s client
  tick, no re-fetch) — ✅
- task modal: id, title, owner, status chip, blocked_reason, claim info
  (worker/pid/elapsed), fails+last_error, note, created/updated, history
  (reverse, changes from→to), logs tail ≤20, action buttons
  claim/release/fail/done/block(reason)/unblock/edit-note/to-ready/change-reason/log-line — ✅
- 403/any error → toast with server {error} text; no silent catches — ✅
- SSE /api/stream EventSource: state|halt|runs events → state refetch;
  reconnect indicator (live/reconnecting dot + rail badge) — ✅
- activity feed newest-first, cap 50 (server feed(50) already capped; UI slices 50) — ✅
- + Add task: title required, board select (default active board, fallback
  first), owner, note, status select todo/ready/blocked, blocked reason
  field required-when-blocked — ✅ (status select = small extension, server-supported)
- style: #121212 bg, accent #bb86fc, status colors per spec, monospace for
  ids/timestamps/logs, cards w/ 1px borders, 8–14px radii, system font,
  responsive @1100/900 breakpoints — ✅
- frozen files untouched: core.js, xtb, server.js, selftest.js (git-status clean of edits) ✅

## Gaps / out-of-bar
- No live browser test (brief forbids; static+serve bar met).
- Visual polish at 1280×800 not pixel-verified (no browser available).
- No delete board button in UI (server has DELETE /api/boards/:id) — not in brief spec.
- v1 tasks without board field render under first board (core.boardOf rule) — handled.
