# Verification — `nz-grocery-prices`

How to confirm a change works. Pair with `command-map.md`.

## Required checks before handoff

1. **`npm run check`** — syntax-checks every source file. Fast. Always run.
2. **`npm test`** — full suite (~477 tests, ~5s). All self-contained now:
   - temp dirs in `os.tmpdir()` for JSONL/DB fixtures
   - in-process HTTP server on port `0` for app/API tests
   - `test/server.test.js` spawns the legacy dashboard as a child process on an
     ephemeral port against a temp fixture JSONL
3. **`npm run pack:check`** — if you changed `package.json` `files`, `exports`,
   or `bin`.

No ESLint or TypeScript compiler exists. `npm run check` is the type gate.

## Targeted verification by layer

| Touched layer | Run |
|---|---|
| `src/adapters/` | `node --test test/adapters/` |
| `src/sqlite/` | `node --test test/sqlite/` |
| `src/server/`, `src/app/` | `node --test test/server/ test/app/` |
| `src/matching/` | `node --test test/matching/` |
| `public/` (frontend) | `node --test test/frontend/` |
| `scripts/archive-daily-local.sh` | `sh -n scripts/archive-daily-local.sh && node --test test/local-archive-runner.test.js` |
| `dashboard/` | `node --test test/server.test.js` |
| `src/archive.js`, `src/analytics.js` | `node --test test/archive.test.js test/analytics.test.js` |

## Test seams (where a new test plugs in)

- **App server / API test** → `createTestServer({ records, appDbInit, skipProjDb })`
  from `test/server/server-helpers.js`. Builds fixture JSONL, projection DB,
  app DB, wires real `Auth`/`Server`, starts on port 0. Use `productRec` /
  `storeRec` / `offerRec` to build records.
- **Adapter logic test** → import the pure `to*Observation` / `parse*Products`
  function and pass hand-crafted fixture objects (see `test/adapters/*.test.js`).
- **Adapter network test** → construct the client with `{ fetch: stubFn,
  transport: "fetch" }` and `clock` for retry timing.
- **SQLite / projection test** → temp dir + `new ProjectionRepository(tmpJsonl,
  tmpDb)` + `rebuild({ force: true })` (see `test/sqlite/projection-repository.test.js`).
- **Archive-runner test** → fake-npm pattern in
  `test/local-archive-runner.test.js` (no network, no real archive).

## Known footguns in verification

- **`npm run archive:local` and `npm run <retailer>` are NOT tests.** They hit
  live retailer APIs and mutate `data/prices.jsonl`. Never run them to "verify"
  a change.
- **`data/prices.jsonl` is live data.** Tests use temp dirs; never point a test
  at the real archive.
- **Node version.** SQLite/app/server tests fail on Node 20 with an
  `ERR_MODULE_NOT_FOUND` for `node:sqlite`. Use Node 26.3.1+.
- **Dead tables.** The projection schema has `deal_signals` and `product_matches`
  tables that are **not populated**. Deals are computed at runtime by
  `src/analytics.js`; match truth is `app.db.product_match_pairs`. Don't write
  tests that assert against the dead tables.
