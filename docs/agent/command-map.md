# Command Map — `nz-grocery-prices`

Canonical commands. Split into **targeted** (fast, one thing) and **full**
checks. Node 26.3.1+ is required for anything using `node:sqlite`; Node 20+
suffices for collectors.

## Prerequisites

- Node 26.3.1+ (for app server, build-db, matching, and SQLite/app/server tests)
- Node 20+ (collectors, CLI, adapter tests)
- No `npm install` needed — zero runtime dependencies.

## Targeted checks (run these first)

| Task | Command |
|---|---|
| Syntax-check all source | `npm run check` |
| Shell syntax of archive runner | `sh -n scripts/archive-daily-local.sh` |
| One test file | `node --test test/sqlite/rebuild.test.js` |
| One test by name | `node --test --test-name-pattern="extracts a normal" test/adapters/foodstuffs.test.js` |
| One test directory | `node --test test/sqlite/` |
| Publishable file set | `npm run pack:check` |

## Retailers campaign (500-retailer roster in `retailers/`)

| Task | Command | Notes |
|---|---|---|
| Roster + per-retailer status | `sed -n '1,60p' retailers/README.md` | manifest with platform + verification notes |
| Collect one retailer (page 1) | `node retailers/<slug>/collect.js --stdout --max-pages 1` | validates each record via `parseObservation` |
| Collect to JSONL | `node retailers/<slug>/collect.js --out /tmp/<slug>.jsonl` | refuses the live archive (`assertNotLiveArchive`) |
| Campaign tests | `node --test "test/retailers/*.test.js"` | family transforms + 50-retailer registry gate |
| Cost-per-request adapters | `--page-size` / `--max-products` flags | pbtech, mitre-10, officemax, moore-wilsons (1 request per product) |

## Full checks

| Task | Command | Notes |
|---|---|---|
| Full test suite | `npm test` | ~880 tests, ~2.8s (perf campaign 2026-09-06: retry/scrypt test seams removed real sleeps). All self-contained (temp dirs, port 0). |
| Lint / typecheck | **none** | no ESLint, no TypeScript compiler. `npm run check` is the syntax gate. |

## Run / dev

| Task | Command | Port | Env |
|---|---|---|---|
| App server (canonical) | `npm start` | 3010 | `PORT`, `HOST`, `JSONL_PATH`, `PRICES_DB`, `APP_DB`, `TRUST_PROXY_HEADERS=1`, `ENABLE_HSTS=1`, `DEALS_CACHE_TTL_MS` (per-retailer /api/deals memoization TTL, default 300000, 0 disables) |
| Rebuild projection DB | `npm run build-db` | — | safe; does not touch `app.db`. Refuses app.db/APP_DB outputs (two-DB rule); refuses v1 archives with the migrator command. Fail-fast `<db>.lock`. |
| Run matching | `npm run matching -- --fuzzy` | — | writes to `app.db.product_match_pairs` |
| Repair archive | `npm run archive:repair -- --file <path>` | — | quarantines corrupt/torn lines, atomically rewrites. Takes the `<archive>.lock` while scanning/rewriting (fails fast if a writer holds it; reclaims it if the holder's pid is dead). Rejects `.db` paths (case-insensitive); accepts `--file <path>` or `--file=<path>`; requires `--force` for `data/prices.jsonl`. Keeps legacy v1 lines byte-for-byte (migration is not repair's job). |
| Migrate legacy v1 archive | `node scripts/migrate-v1-archive.js --file <path> [--dry-run] [--force]` | — | one-shot v1→v2 conversion (CORE-6). Dry run reports `{v1, v2, invalid, changes}` and writes nothing. Apply mode backs up the original bytes (`<file>.pre-v2-migration-<ts>`), quarantines undecodable lines, preserves mixed line order, rewrites atomically under the shared `<archive>.lock`. Refuses `.db` paths and the live `data/prices.jsonl` without `--force`; a clean no-v1 run is a true no-op, while invalid-only input is quarantined without rewriting. |

### Archive writer protocol

All archive mutations (`append`, `compact`, repair, migrate-v1-archive, the
collector publisher) take the same `<archive>.lock` mkdir-based lock and are
mutually exclusive. Appends are fsync'd before in-memory state updates;
compaction/repair/migration replace the file atomically via rename.
`fh.sync()` is fsync(2) — crash-atomic, not a power-loss guarantee on APFS
(see DECISIONLOG 2026-08-23).

### Legacy v1 policy (CORE-6)

v1 whole-observation records are refused everywhere in the hot path:

- `JsonlObservationRepository` load/compact → error naming file:line + the
  migrator command.
- Projection rebuild → refusal before publishing (mixed or v1-only).
- The only converter is `scripts/migrate-v1-archive.js`.

## Collectors (live network — do not run casually)

| Task | Command | Footgun |
|---|---|---|
| One PAK'nSAVE store | `npm run paknsave -- archive "Royal Oak"` | hits live retailer API |
| Every PAK'nSAVE store | `npm run paknsave -- archive --all-stores` | ~57 stores, ~1s delay each |
| Every New World store | `npm run newworld -- archive --all-stores` | ~148 stores |
| Every FreshChoice store | `npm run freshchoice -- archive --all-stores` | ~76 storefronts |
| All retailers, atomic | `npm run archive:local` | **mutates `data/prices.jsonl`**. PAK'nSAVE / New World / FreshChoice default to all stores. Woolworths + Warehouse stay single-context. Never use as a smoke test. |
| Nightly breadth pilot | `npm run breadth:nightly` | **live network collection** into separate `data/breadth-pilot-*.jsonl` archives. Runs four parallel lanes: paknsave→newworld serial (shared Foodstuffs mobile host, `BREADTH_FS_DELAY_MS` paces both, 3000 on trial since 2026-09-05), plus freshchoice, warehouse, and woolworths overlapped on their own hosts. Page-0 discovery checkpoints in each `<archive>.breadth-manifest.json` and ages out after 3 days (`--force-discovery` re-crawls immediately); the min-products health floor binds only on discovery nights — small straggler-refresh nights are judged per-node (any page failure, error, or empty seed fails the lane; failed pages are walker-retried, then mark `incompleteCoverage`). Each lane is unhealthy unless it collects at least its `--min-expected-products` floor; bootstrap fetches (store list / category tree) retry in rounds before a lane aborts. Logs live in `data/logs/` (`nz-grocery-breadth.{log,error.log,health.jsonl}`; the health log is the gate/report input). An unhealthy lane's full summary JSON is appended to the run log. |
| Breadth report | `npm run breadth:report` | Read-only report from the latest breadth health log and pilot archives; writes `reports/breadth-report-<NZ-date>.md`, never calls retailer APIs. |
| Install breadth schedule | `sh ops/install-breadth-agent.sh` | Installs/refreshes the 3:30am user LaunchAgent (`~/Library/LaunchAgents/nz.grocery-prices.breadth-pilot.plist`). No sudo; the job fires while the user is logged in. Logs land in `data/logs/`. |

## Asset build (optional, perf campaign 2026-09-06)

| Task | Command | What it does |
|---|---|---|
| Build hashed assets | `npm run build:assets` | Content-hashes `public/` into `public-dist/` (rewrites index.html + ES-module import specifiers) and emits precompressed `.br`/`.gz` sidecars per file; the dist static server ships sidecars directly and only falls back to lazy compression when one is missing. The app server prefers `public-dist/` when present and serves assets `immutable`; delete `public-dist/` (or skip building) for dev mode on plain `public/`. Restart the server after building. |

## Benchmarks (perf campaign 2026-09-06)

| Task | Command | Measures | Needs |
|---|---|---|---|
| Server endpoint latency | `npm run bench` | cold boot, per-endpoint p50/p95 + chronological `first` sample, wire/raw bytes + negotiated encoding (browser-like `gzip, deflate, br` by default; `--accept-encoding identity` to compare), `app.js`, and suggestions + deals 8×5 bursts; static URLs resolve via `public-dist/manifest.json` in dist mode. Flags: `--port`, `--reps`, `--quiet`, `--json` (tools/bench-server.js) | a built projection DB (`data/prices.db` — build with `npm run build-db`; override with `JSONL_PATH`/`PRICES_DB` env) |
| Archive load / RAM | `npm run bench:archive` | JsonlObservationRepository load time + RSS, full calculateSales pass (tools/bench-archive.js) | `data/prices.jsonl` (override with `--jsonl <path>`) |

Both are read-only against the archive and safe to run anytime; they never
call retailer APIs. Re-run after each nightly archive growth to watch trends.

## Known slow / side-effecting checks

- `test/local-archive-runner.test.js` — runs the real shell script with a fake npm (no network, no real archive).
- `npm run archive:local` and any `npm run <retailer>` — **live network collection, mutates data**. Not tests.

## Verify after a change

1. `npm run check` (syntax)
2. `npm test` (full suite) — or the targeted file/dir for the layer you touched
3. `npm run pack:check` if you changed `package.json` `files` or exports
