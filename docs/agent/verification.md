# Verification — `nz-grocery-prices`

How to confirm a change works. Pair with `command-map.md`.

## Required checks before handoff

1. **`npm run check`** — syntax-checks every source file. Fast. Always run.
2. **`npm test`** — full suite (~1,020 tests, ~3.5s as of the 2026-09-09 perf trial). All self-contained:
   - temp dirs in `os.tmpdir()` for JSONL/DB fixtures
   - in-process HTTP server on port `0` for app/API tests
   - (The legacy dashboard child-process test was deleted with the dashboard
     in CORE-6.)
3. **`npm run pack:check`** — if you changed `package.json` `files`, `exports`,
   or `bin`.

No ESLint or TypeScript compiler exists. `npm run check` is the type gate.

## Targeted verification by layer

| Touched layer | Run |
|---|---|
| `src/adapters/` | `node --test 'test/adapters/*.test.js'` |
| `src/sqlite/` | `node --test 'test/sqlite/*.test.js'` |
| `src/server/`, `src/app/` | `node --test 'test/server/*.test.js' 'test/app/*.test.js'` |
| `src/matching/` | `node --test 'test/matching/*.test.js'` |
| `public/` (frontend) | `node --test 'test/frontend/*.test.js'` |
| `scripts/archive-daily-local.sh` | `sh -n scripts/archive-daily-local.sh && node --test test/local-archive-runner.test.js` |
| `scripts/woolworths-breadth.js`, breadth gate | `node --test test/woolworths-breadth.test.js test/breadth-pilot-gate.test.js` |
| `scripts/warehouse-breadth.js` + adapter, `scripts/lib/crawler.js` | `node --test test/warehouse-breadth.test.js test/crawler.test.js` |
| `scripts/foodstuffs-mobile-breadth.js`, `scripts/freshchoice-breadth.js` | `node --test test/foodstuffs-mobile-breadth.test.js test/freshchoice-breadth.test.js` |
| `scripts/lib/breadth-helpers.js` (shared breadth helpers, discovery TTL) | `node --test test/breadth-helpers.test.js` |
| `scripts/purge-breadth-archive.js` (one-shot archive purge) | `node --test test/purge-breadth-archive.test.js` |
| `scripts/breadth-pilot-nightly.sh` | `sh -n scripts/breadth-pilot-nightly.sh` |
| `scripts/breadth-report.js` | `node --test test/breadth-report.test.js` |
| `src/archive.js`, `src/analytics.js` | `node --test test/archive.test.js test/analytics.test.js` |
| `src/index.js` + `.d.ts` public surface | `node --test test/types-surface.test.js`; `npm run pack:check` after any package.json change |
| `src/repository.js` writer/load/repair | `node --test test/repository-writer.test.js test/repository-load.test.js test/repository-repair.test.js` |
| `src/archive-index.js` | `node --test test/archive-index.test.js test/repository-writer.test.js test/repository-load.test.js` |
| `scripts/migrate-v1-archive.js`, v1 refusal paths | `node --test test/migrate-v1.test.js test/repository-load.test.js test/sqlite/rebuild.test.js` |

## Test seams (where a new test plugs in)

- **App server / API test** → `createTestServer({ records, appDbInit, skipProjDb })`
  from `test/server/server-helpers.js`. Builds fixture JSONL, projection DB,
  app DB, wires real `Auth`/`Server`, starts on port 0. Use `productRec` /
  `storeRec` / `offerRec` to build records.
- **Adapter logic test** → import the pure `to*Observation` / `parse*Products`
  function and pass hand-crafted fixture objects (see `test/adapters/*.test.js`).
- **Retailers campaign test** → family tests in `test/retailers/` pass fixture
  HTML/JSON through the `retailers/_lib/*` families and validate the result
  with `parseObservation`; `retailer-registry.test.js` imports every
  `retailers/<slug>/index.js` and asserts the RETAILER/createClient contract
  (no network).
- **Adapter network test** → construct the client with `{ fetch: stubFn,
  transport: "fetch" }` and `clock` for retry timing.
- **SQLite / projection test** → temp dir + `new ProjectionRepository(tmpJsonl,
  tmpDb)` + `rebuild({ force: true })` (see `test/sqlite/projection-repository.test.js`).
- **Archive-runner test** → fake-npm pattern in
  `test/local-archive-runner.test.js` (no network, no real archive).
- **v1 migration test** → temp-dir CLI pattern in `test/migrate-v1.test.js`:
  run `scripts/migrate-v1-archive.js` via `execFile` against temp copies only;
  never the live archive.

## Known footguns in verification

- **`npm run archive:local` and `npm run <retailer>` are NOT tests.** They hit
  live retailer APIs and mutate `data/prices.jsonl`. Never run them to "verify"
  a change.
- **`data/prices.jsonl` is live data.** Tests use temp dirs; never point a test
  at the real archive. Verify migrator behavior on live data by COPYING it to
  a temp path and dry-running the copy.
- **v1 fixtures are refused, not imported.** Post-CORE-6, a legacy v1 line in
  any fixture makes the loader/rebuild throw with the migrator command — that
  refusal is the expected behavior to assert, not a bug.
- **Node version.** SQLite/app/server tests fail on Node 20 with an
  `ERR_MODULE_NOT_FOUND` for `node:sqlite`. Use Node 26.3.1+.
- **Dead tables.** The projection schema has `deal_signals` and `product_matches`
  tables that are **not populated**. Deals are computed at runtime by
  `src/analytics.js`; match truth is `app.db.product_match_pairs`. Don't write
  tests that assert against the dead tables.
