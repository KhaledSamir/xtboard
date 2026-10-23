# xtboard

Pi-native, **no-daemon** multi-board task orchestrator (Dashboard V2 for the XTranslator fleet).

Design invariants:
- **Zero npm dependencies** — Node 24 builtins only. No `package.json`, no `npm install`.
- **State is plain JSON files**. The `xtb` CLI works with the server *stopped*: state files are the source of truth, the server is a thin API/UI layer.
- CLI and server share one engine (`core.js`) → identical semantics, one lock, one audit log.
- Web UI is a single `index.html` with **no external/CDN requests** (works behind CasaOS / offline).

## Layout

| File | Role |
|---|---|
| `core.js` | state engine: boards, tasks, claims, halt, imports (v1 `xt` CLI format), locks, audit log |
| `xtb` | CLI (boards / tasks / claim / next / halt / migrate-import) |
| `server.js` | HTTP API + SSE live feed on port **9119** |
| `index.html` | dark modern UI: boards, cards, live elapsed timers, claim/release/fail/done, pause/resume, halt |
| `selftest.js` | hermetic self-test suite (fresh temp state dirs; **23/23 must pass**) |

## Quickstart

```bash
node selftest.js          # 23/23 ALL PASS required

# CLI (works with no server running)
xtb boards
xtb add "write the parser" --owner worker --board features --status ready
xtb list --board features
xtb claim <task-id> worker [--force]
xtb log <task-id> "progress note"
xtb done <task-id> "evidence summary"
xtb next --claim --owner worker      # claim oldest ready task from MY pool
xtb counts / xtb status / xtb halt [--kill] / xtb resume / xtb migrate (import a v1 board.json)

# server + UI
node server.js             # → http://localhost:9119
```

## Owner assignment (claim enforcement)

Tasks carry an `owner` (the agent pool the Architect assigned at creation). Claiming is **enforced**:

| Claimant | Result |
|---|---|
| owner named on the task | ✅ allowed |
| orchestrator identities (`pi`, `web`, `xtranslator-architect`, `architect`) | ✅ always allowed (manual takeover / human takeover) |
| any other agent pool | ❌ refused — `task … is assigned to '<owner>'` |
| `--force` (CLI) or `{"force":true}` (API) | ✅ explicit override, audited in history |

`xtb next --claim --owner <pool>` picks the oldest ready task **from that pool only** (unassigned tasks are not handed out to a named pool) and then claims it under the same rules.

## API (server.js)

- `GET /api/state` — full board state (boards, tasks, counts, halt)
- `GET /api/stream` — SSE live feed
- `POST /api/boards` `{name}` · `PATCH /api/boards/<id|name>` `{name?, active?}` · `DELETE /api/boards/<id>`
- `POST /api/tasks` `{title, board?, owner?, status?, note?, blocked_reason?}`
- `PATCH /api/tasks/<id>` `{title, owner, note, status, blocked_reason, board}`
- `POST /api/tasks/<id>/<action>` — actions: `log, claim, release, fail, done, block, unblock`; claim body `{worker?, force?}` (see owner enforcement above)
- `POST /api/halt` `{mode:"drain"|"kill"}` · `POST /api/resume`

## Docker / CasaOS

```bash
docker build -t xtboard .
# or
docker compose up -d
```

Volumes: `~/.pi/xtboard` (state) mounted at `/home/xtboard/.pi/xtboard`. Port 9119. No other services required.

## Testing

`selftest.js` covers the full surface hermetically (lifecycle A1–A16, boards, import C1/C2, CLI D1, halt --kill E1, owner enforcement F1/F2). Each case runs in a fresh temp `XTBOARD_HOME` — the real state dir is never touched.
