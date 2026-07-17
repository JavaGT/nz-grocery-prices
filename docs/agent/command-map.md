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
| Live public site | `npm start` / `npm run site` | 7070 | `site/server.mjs`. Needs `node_modules/workbench` link. `PORT`, `PRICE_ARCHIVE_FILE` (default `data/archive.db`), `SITE_DB`. nginx → 7070. |
| Site tests | `npm run test:site` | — | Workbench app contract tests |
| Legacy dashboard (deprecated) | `npm run dashboard` | 7071 | Avoid 7070 (live site). |
| Rebuild projection DB | `npm run build-db` | — | from `data/archive.db` (fallback `prices.jsonl`); does not touch `app.db` |
| Migrate JSONL → archive.db | `npm run migrate-archive` | — | one-shot stream import; never opens `app.db` |
| Run matching | `npm run matching -- --fuzzy` | — | writes to `app.db.product_match_pairs` |

## Collectors (live network — do not run casually)

| Task | Command | Footgun |
|---|---|---|
| One PAK'nSAVE store | `npm run paknsave -- archive "Royal Oak"` | hits live retailer API |
| Every PAK'nSAVE store | `npm run paknsave -- archive --all-stores` | ~57 stores, ~1s delay each |
| Every New World store | `npm run newworld -- archive --all-stores` | ~148 stores |
| Every FreshChoice store | `npm run freshchoice -- archive --all-stores` | ~76 storefronts |
| Every Woolworths store | `npm run woolworths -- archive --all-stores` | ~180 pickup stores; session-switches fulfilment |
| All retailers → live DB | `npm run archive:local` | **writes straight into `data/archive.db`** (or `ARCHIVE_FILE`). No stage/rename. Skips stores observed within `MAX_AGE_HOURS` (default 12; set `0` to force). PAK'nSAVE / New World / FreshChoice / Woolworths = all stores. Warehouse national-online. Never a smoke test. |

## Known slow / side-effecting checks

- `test/server.test.js` — spawns the legacy dashboard as a child process (~170ms).
- `test/local-archive-runner.test.js` — runs the real shell script with a fake npm (no network, no real archive).
- `npm run archive:local` and any `npm run <retailer>` — **live network collection, mutates data**. Not tests.

## Verify after a change

1. `npm run check` (syntax)
2. `npm test` (full suite) — or the targeted file/dir for the layer you touched
3. `npm run pack:check` if you changed `package.json` `files` or exports
