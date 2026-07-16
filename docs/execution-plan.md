# Execution Plan: NZ Grocery Price Intelligence

**Date:** 2026-07-16
**Derived from:** `docs/implementation-spec.md` after plan-checker review
**Architecture:** Design B — clean canonical ownership (node:sqlite, two-DB separation)
**Runtime:** Node.js 26.3.1 (built-in `node:sqlite`)

---

## Architecture Choice: Design B over Design A

### Design A: Minimal migration/reuse (better-sqlite3, single DB)
- Adapt worktree's existing `SqliteObservationRepository` (better-sqlite3, dual-write → read-only)
- Single `data/prices.db` containing both projection and user tables
- Pros: reuses proven code, worktree tests already pass
- Cons: requires native module compilation (C++ toolchain), npm dependency, single-DB rebuild risks user data

### Design B: Clean canonical ownership (node:sqlite, two-DB separation)
- Use Node.js 26.3.1 built-in `node:sqlite` — zero dependencies
- Two SQLite DBs: `data/prices.db` (rebuildable projection) + `data/app.db` (persistent user data)
- Rewrite projection code from worktree using `node:sqlite` API
- Pros: zero packaging risk, no native compilation, clear ownership boundary, rebuild never touches user data
- Cons: must rewrite worktree's SQLite code for `node:sqlite` API

### Evidence
| Factor | better-sqlite3 (A) | node:sqlite (B) |
|--------|-------------------|-----------------|
| npm dependency | required | zero |
| Native compilation | required | none |
| Available now | must install and compile | built into Node 26.3.1 |
| WAL mode | yes | yes |
| Prepared statements | yes | yes |
| Sync API | yes | yes |
| Backup API | extension | built-in |
| Projection vs app-state safety | shared DB, risk on rebuild | separate DBs, impossible to corrupt |
| Worktree code reuse | direct adaptation | must rewrite |

**Decision: Design B.** Zero dependencies, zero native compilation, zero-risk rebuild isolation.

---

## Work Packets

Each packet is a "DeepSeek-sized" unit: 1–3 files to create/edit, explicit dependencies, scriptable verification. Packets within a phase are independent and parallelizable.

---

### Phase 0: Environment & Validation (2 packets)

#### P0.1 Verify baseline
- **Files:** (none created)
- **Action:** `node -e "require('node:sqlite'); console.log('ok')"` — verify node:sqlite works
- **Action:** `node --test test/archive.test.js test/analytics.test.js test/local-archive-runner.test.js` — verify existing tests pass BEFORE any changes
- **Dependencies:** none
- **Verify:** `echo "node:sqlite ok"` and all existing tests pass
- **Revert if fail:** Do not proceed if node:sqlite is unavailable or existing tests fail

#### P0.2 Verify current dirty state
- **Files:** (none created)
- **Action:** `git status --short` — list current dirty files; `git diff --stat` — confirm no unrelated files will be touched
- **Dependencies:** P0.1
- **Verify:** Stashed/uncommitted changes logged; execution plan will not touch them
- **Revert if fail:** Halt if diff reveals committed files that would be overwritten

---

### Phase 1: SQLite Projection Foundation (6 packets)

#### P1.1 Create projection schema migration
- **File:** `src/sqlite/migrations/projection/001_initial.sql`
- **Content:** All projection DB tables (retailers, price_contexts, products, product_revisions, store_revisions, offer_revisions, special_snapshots, price_observations VIEW, product_matches, deal_signals, schema_migrations, import_runs, _meta)
- **Dependencies:** P0.1
- **Verify:** `node -e "require('node:fs').readFileSync('src/sqlite/migrations/projection/001_initial.sql','utf8')"` — file is readable and non-empty

#### P1.2 Create schema module with migration runner
- **File:** `src/sqlite/schema.js`
- **Content:** `applyMigrations(db, migrationsDir)` — reads `.sql` files in order, applies each not yet in `schema_migrations` table, logs duration. Exports `applyProjectionMigrations(db)` and `applyAppMigrations(db)`.
- **Dependencies:** P1.1
- **Verify:** `node --check src/sqlite/schema.js`

#### P1.3 Create projection repository
- **File:** `src/sqlite/projection-repository.js`
- **Content:** `ProjectionRepository` class using `node:sqlite.DatabaseSync`. Methods: `constructor(jsonlPath)`, `query(query = {})`, `productHistory(productId)`, `rebuild()`, `close()`. No `append()` — this is read-only. Build logic: read JSONL, parse v2 records, insert into normalized tables, compute fingerprint, store in `_meta`. On existing matching fingerprint, skip rebuild.
- **Dependencies:** P1.2
- **Verify:** `node --check src/sqlite/projection-repository.js`

#### P1.4 Create build-db CLI
- **File:** `scripts/build-db.js`
- **Content:** Script that imports `ProjectionRepository`, opens the JSONL file path, calls `rebuild()`, logs result. Supports `--force` (delete DB first) and `--file` (custom JSONL path).
- **Dependencies:** P1.3
- **Verify:** `node --check scripts/build-db.js`

#### P1.5 Write projection tests
- **Files:** 
  - `test/sqlite/projection-repository.test.js` — rebuild from fixture JSONL, query, dedup, equivalence with `JsonlObservationRepository`
  - `test/sqlite/schema.test.js` — migration application, idempotency, version check
  - `test/sqlite/rebuild.test.js` — deterministic rebuild (same JSONL → same fingerprint → no-op), malformed JSONL skipping, missing JSONL fallback
  - `test/sqlite/rollback.test.js` — transaction rollback on rebuild failure preserves existing DB, missing archive, stale archive
  - `test/sqlite/concurrency.test.js` — SQLITE_BUSY handling with concurrent processes (test uses lock file simulation)
- **Dependencies:** P1.4
- **Verify:** `node --test test/sqlite/`

#### P1.6 Update package.json scripts
- **File:** `package.json`
- **Edits:** Add `"build-db": "node scripts/build-db.js"`, add `"start": "node src/app/server.js"` (server created later), keep existing scripts
- **Dependencies:** P1.4
- **Verify:** `node -e "const p = require('./package.json'); console.log(p.scripts['build-db'])"` — script exists

---

### Phase 2: Application DB & Auth (3 packets)

#### P2.1 Create app DB schema migration
- **File:** `src/sqlite/migrations/app/001_app_auth.sql`
- **Content:** All app DB tables (users, sessions, user_store_preferences, saved_searches, watch_list_entries, new_product_notices, rate_limit, schema_migrations)
- **Dependencies:** P1.2
- **Verify:** File is readable and non-empty

#### P2.2 Create app DB module
- **File:** `src/sqlite/app-db.js`
- **Content:** `AppDatabase` class using `node:sqlite.DatabaseSync`. Opens/manages `data/app.db`. Applies app migrations on open. Methods: `getUserByUsername()`, `createUser()`, `getSession()`, `createSession()`, `deleteSession()`, `cleanExpiredSessions()`, CRUD for preferences/watch/searches/notices.
- **Dependencies:** P2.1
- **Verify:** `node --check src/sqlite/app-db.js`

#### P2.3 Create auth module
- **File:** `src/app/auth.js`
- **Content:** `Auth` class with `register(username, password)`, `login(username, password)` → session token, `logout(sessionToken)`, `getSessionUser(sessionToken)`. Uses `crypto.scrypt` (async, NOT scryptSync). Salt 16 bytes, N=16384, r=8, p=1. Session token: 32 bytes `crypto.randomBytes`, hex-encoded, 24h expiry.
- **Dependencies:** P2.2
- **Verify:** `node --check src/app/auth.js`

#### P2.4 Write app DB + auth tests
- **Files:**
  - `test/sqlite/app-db.test.js` — user CRUD, session CRUD, preference/watch/search CRUD, expiry cleanup
  - `test/app/auth.test.js` — register, login, logout, session expiry, duplicate user rejection, invalid credentials
- **Dependencies:** P2.3
- **Verify:** `node --test test/sqlite/app-db.test.js test/app/auth.test.js`

---

### Phase 3: Trust & Adapter Resilience (3 packets)

#### P3.1 Create fetchWithRetry helper
- **File:** `src/adapters/fetch-with-retry.js`
- **Content:** `fetchWithRetry(url, options)` — accepts `AbortSignal` (default timeout 15s), retries on 429/502/503/504 up to 3 times, respects `Retry-After`, exponential backoff 1s/2s/4s, no retry on non-GET, no retry if aborted, throws `TimeoutError` on timeout.
- **Dependencies:** none (standard library only)
- **Verify:** `node --check src/adapters/fetch-with-retry.js`

#### P3.2 Update adapters to use shared helper
- **Files:** `src/adapters/foodstuffs.js`, `woolworths.js`, `freshchoice.js`, `warehouse.js`
- **Edits:** Replace direct `fetch` with `fetchWithRetry` from the shared helper. Add AbortSignal support to all collector methods.
- **Dependencies:** P3.1
- **Verify:** `node --check src/adapters/*.js`

#### P3.3 Write adapter fixture tests
- **Files:**
  - `test/adapters/foodstuffs.test.js` — HAR-based fixture tests
  - `test/adapters/woolworths.test.js`
  - `test/adapters/freshchoice.test.js`
  - `test/adapters/warehouse.test.js`
- **Each verifies:** correct extraction, missing fields → null, unexpected structure → partial data (not throw)
- **Dependencies:** P3.2
- **Verify:** `node --test test/adapters/`

---

### Phase 4: App Server Core (5 packets)

#### P4.1 Create HTTP server entry point
- **File:** `src/app/server.js`
- **Content:** Startup sequence: (1) open app DB → apply migrations; (2) open projection DB → apply migrations; (3) check JSONL fingerprint → rebuild if stale; (4) start HTTP listener; (5) serve 503 during migration. Uses `node:http` (no framework). Configurable port via `PORT` env var (default 3010).
- **Dependencies:** P1.3 (projection repo), P2.2 (app DB)
- **Verify:** `node --check src/app/server.js`

#### P4.2 Implement public API endpoints
- **File:** `src/app/api/public.js`
- **Endpoints:** `GET /api/deals`, `GET /api/products`, `GET /api/products/:id`, `GET /api/products/:id/history`, `GET /api/stores`, `GET /api/search/suggestions`, `GET /api/health`
- **Each endpoint:** validates params, handles empty/single/multi states, includes `_freshness` in response
- **Dependencies:** P4.1
- **Verify:** `node --check src/app/api/public.js`

#### P4.3 Implement authenticated API endpoints
- **File:** `src/app/api/private.js`
- **Endpoints:** `GET/POST/DELETE /api/watch-list`, `GET/POST/DELETE /api/preferred-stores`, `GET/POST/DELETE /api/saved-searches`, `GET /api/new-products`
- **Auth:** Checks `sid` cookie via `Auth.getSessionUser()`; returns 401 if invalid
- **Dependencies:** P2.3 (auth), P4.2
- **Verify:** `node --check src/app/api/private.js`

#### P4.4 Adapt SPA from Workbench prototype
- **Files:** `public/index.html`, `public/api.js`, `public/app.js`
- **Actions:** Copy Workbench `server.mjs` SPA routes and `public/index.html` into `public/`. Change API paths: `/auth/me` → server-managed auth, `/watch-list` → `/api/watch-list`, `/preferred-stores` → `/api/preferred-stores`. Remove Workbench framework dependency from client code. The SPA is static HTML+JS served from `/`.
- **Dependencies:** P4.3
- **Verify:** `node --test test/app/` (API contract tests use real HTTP)

#### P4.5 Write API contract tests
- **Files:**
  - `test/app/server.test.js` — all public endpoints, state handling, error codes
  - `test/app/permissions.test.js` — 401 on private endpoints, 404 on wrong owner, request size limit, product ID validation
  - `test/app/adversarial.test.js` — injection attempts, XSS in query params, oversized bodies, invalid product IDs
- **Dependencies:** P4.3
- **Verify:** `node --test test/app/server.test.js test/app/permissions.test.js test/app/adversarial.test.js`

---

### Phase 5: Price-minder Features (2 packets)

#### P5.1 Feed prioritization and saved searches
- **File:** `src/app/api/public.js` (amend)
- **Edits:** Feed prioritization: watch-list products at preferred stores first, then watch-list at other stores, then all deals. Tier sorting by discount magnitude.
- **File:** `src/app/api/private.js` (amend)
- **Edits:** Saved searches CRUD, new-products detection per user
- **Dependencies:** P4.3
- **Verify:** `node --check src/app/api/public.js src/app/api/private.js`

#### P5.2 UI state coverage and freshness indicators
- **Files:** `public/index.html`, `public/app.js`
- **Edits:** Implement all empty/single/multi/error/stale states from spec §5.1. Add image fallback chain (§5.2). Add archive freshness indicators (§5.3). Add price context display (§5.4).
- **Dependencies:** P5.1
- **Verify:** `node --test test/app/feed.test.js`

---

### Phase 6: Matching Pilot (2 packets)

#### P6.1 Matching engine
- **File:** `src/sqlite/matching.js`
- **Content:** `autoMatchBySourceId(db)`, `autoMatchByGtin(db)`, `fuzzyMatchCandidates(db)`, `humanReviewMatch(db, matchId, action)`. All matching writes go to `product_matches` table in projection DB.
- **Dependencies:** P1.3
- **Verify:** `node --check src/sqlite/matching.js`

#### P6.2 Matching CLI and tests
- **File:** `scripts/matching-cli.js` — CLI for listing pending matches, accepting/rejecting
- **Files:** `test/app/matching.test.js` — auto GTIN, auto source ID, human review, fuzzy candidate isolation
- **Dependencies:** P6.1
- **Verify:** `node --test test/app/matching.test.js`

---

### Phase 7: Deprecation, Documentation & Integration (3 packets)

#### P7.1 Deprecation notices (non-destructive)
- **File:** `dashboard/server.js` (amend first line)
- **Edit:** Add `console.warn('DEPRECATED: Use npm start for the new server at src/app/server.js')` at top. Do NOT delete any files.
- **File:** `dashboard/README.md` (create) — pointer to new server
- **File:** `.worktrees/sqlite-migration/README.md` (create) — pointer noting work absorbed into main
- **File:** `workbench/projects/grocery-prices/POINTER.md` (create) — pointer noting app moved to prices repo
- **Dependencies:** P4.3 (server must exist first)
- **Verify:** `ls dashboard/` — all original files present

#### P7.2 Documentation pass
- **Files:** `README.md`, `HANDOFF.md`, `CONTEXT.md` (if exists)
- **Edits:** Update for new server, two-DB architecture, node:sqlite choice, deprecation status. Ensure all file paths are accurate.
- **Dependencies:** P7.1
- **Verify:** `npm run check` — syntax check passes

#### P7.3 Full system integration test
- **Command:** `npm test && npm run check && npm run pack:check`
- **Verifies:** All 31 MUST constraints, both DB schemas, rebuild, rollback, auth, API, matching, deprecation pointers
- **Benchmark:** `time node scripts/build-db.js` — measure rebuild time for production archive
- **Dependencies:** All prior phases
- **Verify:** Exit code 0 on all three commands

---

## Verification Cadence

Within each phase, verification runs after every 2–3 packets (Nyquist compliance). The full verification schedule:

| After | Command | Catches |
|-------|---------|---------|
| P1.4 | `node --check src/sqlite/*.js scripts/build-db.js` | Syntax errors in projection layer |
| P1.6 | `node --test test/sqlite/` | Projection rebuild, query, rollback, concurrency |
| P2.4 | `node --test test/sqlite/app-db.test.js test/app/auth.test.js` | App DB + auth correctness |
| P3.3 | `node --test test/adapters/` | Adapter resilience |
| P4.5 | `node --test test/app/` | Full API contract, permissions, adversarial |
| P5.2 | `node --test test/app/feed.test.js` | Feature correctness |
| P6.2 | `node --test test/app/matching.test.js` | Matching correctness |
| P7.3 | `npm test && npm run check && npm run pack:check` | Full system integration |

---

## Completion Gates

The programme is complete when all of:

1. `npm test` exits 0 (all 31 MUSTs tested)
2. `node scripts/build-db.js` rebuilds `data/prices.db` from live `data/prices.jsonl` with equivalence verified
3. `npm start` launches HTTP server serving full SPA on port 3010
4. `dashboard/server.js` prints deprecation warning but still runs
5. `.worktrees/sqlite-migration/` and `workbench/projects/grocery-prices/` untouched; pointer files present
6. `npm run check && npm run pack:check` both exit 0
7. Rebuild test proves `data/app.db` is never touched by projection rebuild
8. Rollback test proves rebuild failure leaves existing DB intact
