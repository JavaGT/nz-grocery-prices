# Command Map — `nz-grocery-prices`

Canonical commands. Split into **targeted** (fast, one thing) and **full**
checks. Node 26.3.1+ is required for anything using `node:sqlite`; Node 20+
suffices for collectors and the legacy dashboard.

## Prerequisites

- Node 26.3.1+ (for app server, build-db, matching, and SQLite/app/server tests)
- Node 20+ (collectors, CLI, legacy dashboard, adapter tests)
- No `npm install` needed — zero runtime dependencies.

## Targeted checks (run these first)

| Task | Command |
|---|---|
| Syntax-check all source | `npm run check` |
| Shell syntax of archive runner | `sh -n scripts/archive-daily-local.sh` |
| One test file | `node --test test/sqlite/projection-repository.test.js` |
| One test by name | `node --test --test-name-pattern="extracts a normal" test/adapters/foodstuffs.test.js` |
| One test directory | `node --test test/sqlite/` |
| Publishable file set | `npm run pack:check` |

## Full checks

| Task | Command | Notes |
|---|---|---|
| Full test suite | `npm test` | ~477 tests, ~5s. All self-contained (temp dirs, port 0, child-process dashboard). |
| Lint / typecheck | **none** | no ESLint, no TypeScript compiler. `npm run check` is the syntax gate. |

## Run / dev

| Task | Command | Port | Env |
|---|---|---|---|
| App server (canonical) | `npm start` | 3010 | `PORT`, `HOST`, `JSONL_PATH`, `PRICES_DB`, `APP_DB`, `TRUST_PROXY_HEADERS=1`, `ENABLE_HSTS=1` |
| Legacy dashboard (deprecated) | `npm run dashboard` | 7070 | `DASHBOARD_PORT`, `PRICE_FILE` |
| Rebuild projection DB | `npm run build-db` | — | safe; does not touch `app.db` |
| Run matching | `npm run matching -- --fuzzy` | — | writes to `app.db.product_match_pairs` |

## Collectors (live network — do not run casually)

| Task | Command | Footgun |
|---|---|---|
| One PAK'nSAVE store | `npm run paknsave -- archive "Royal Oak"` | hits live retailer API |
| Every PAK'nSAVE store | `npm run paknsave -- archive --all-stores` | ~57 stores, ~1s delay each; live network |
| All retailers, atomic | `npm run archive:local` | **mutates `data/prices.jsonl`**. PAK'nSAVE defaults to all stores. Never use as a smoke test. |

## Known slow / side-effecting checks

- `test/server.test.js` — spawns the legacy dashboard as a child process (~170ms).
- `test/local-archive-runner.test.js` — runs the real shell script with a fake npm (no network, no real archive).
- `npm run archive:local` and any `npm run <retailer>` — **live network collection, mutates data**. Not tests.

## Verify after a change

1. `npm run check` (syntax)
2. `npm test` (full suite) — or the targeted file/dir for the layer you touched
3. `npm run pack:check` if you changed `package.json` `files` or exports
