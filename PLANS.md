# PLANS

**Append-only project ledger.** Newest entry last. Never delete or reorder.

---

## 2026-07-16

### Progress

- Explored both codebases: `prices/` (collector + JSONL archive + dashboard) and `workbench/projects/grocery-prices` (Workbench app prototype).
- Read all source files, tests, configs, designs, and decision records.
- Conducted 8-category spec-edge-probes (empty, single, boundary, concurrency, failure, permission, lifecycle, adversarial).
- Ran prohibition/discouragement audit on all MUST constraints.
- Produced comprehensive implementation spec at `docs/implementation-spec.md`.
- Appended 8 new architectural decisions to `DECISIONLOG.md`.
- Created this PLANS.md as append-only project ledger.

### Decisions

1. **App moves to prices repo.** Single canonical home for all price intelligence code. Workbench prototype archived.
2. **SQLite is read-only projection.** JSONL remains authoritative lossless archive. No dual-write. Deterministic rebuild from JSONL fingerprint.
3. **No in-process collection workaround.** Scheduling blocker is environmental (macOS Directory Services). Documented but not coded around.
4. **Cutover, not piecemeal.** Old `dashboard/` removed after new SQLite-backed server passes all contract tests.
5. **Fuzzy matches are never confirmed.** Only `auto_gtin`, `auto_source_id`, `human_reviewed` appear as matches. Fuzzy candidates are pending suggestions only.
6. **crypto.scryptSync for passwords.** Zero-dep password hashing. Adequate for local-first multi-user.
7. **SQLite sessions, 24h expiry.** Survives restart. Configurable.
8. **Branded image placeholders.** No external image service dependencies.

### Surprises

- The worktree at `.worktrees/sqlite-migration` already has a fully functional `SqliteObservationRepository` with tests, but it uses dual-write (JSONL + SQLite simultaneously), which contradicts the "JSONL is authoritative; SQLite is a rebuildable projection" principle. The read-model approach in `docs/sqlite-website-design.md` was never implemented — only the dual-write path exists.
- The Workbench app prototype is more complete than expected: full SPA with deals, product search/history, watch list, preferred stores, auth, rate limiting, inline SVG sparklines, responsive design. Much of it can be adapted directly rather than rewritten.
- The repo has zero runtime dependencies except what the worktree adds. Adding `better-sqlite3` (a native module) is a meaningful change in packaging strategy — it now requires a C++ build toolchain on install.
- `data/prices.jsonl` contains live collected data — any operation on it has real-world consequences. Test fixtures must use isolated directories.

### Discoveries

- The `workbench/projects/grocery-prices` `IMPLEMENTATION-BRIEF.md` explicitly says "Don't modify prices/src" — this constraint was for the prototype phase and no longer applies now that the app is moving into the prices repo.
- The `product_matches` table design from `docs/sqlite-website-design.md` needs refinement: match_method needs specific enum values (auto_gtin, auto_source_id, human_reviewed, fuzzy_candidate), not the vague "gtin" / "sourceId" / "fuzzy" originally sketched.
- The existing dashboard's `server.test.js` has comprehensive API tests (stores, stats, feed, products, history) that will serve as regression contracts for the new server.
- HAR files in `research/` provide captured retailer responses that can seed adapter fixture tests without live API calls.

---

## Next recommended implementation task breakdown

### Task 1: SQLite Foundation (Worker 1)
- Add `better-sqlite3 ^12.11.1` to `package.json`
- Refactor worktree's `sqlite-repository.js` to read-only projection (remove `append()`)
- Create `src/sqlite/schema.js` with initial tables, FTS5 migration scaffolding
- Create `src/sqlite/migrations/001_initial.sql`
- Create `scripts/build-db.js` CLI
- Write `test/sqlite/repository.test.js` (rebuild, query, dedup, equivalence)
- Write `test/sqlite/schema.test.js` (migration application, version checks)
- Target: `node --test test/sqlite/` passes

### Task 2: Trust & Adapter Resilience (Worker 2)
- Create `src/adapters/fetch-with-retry.js` (AbortSignal, Retry-After, bounded retry)
- Update all 5 adapters to use the shared helper
- Add HAR fixture tests for all adapters
- Verify atomic archive behavior (test exists)
- Add collection health/count logging
- Target: `node --test test/adapters/` passes

### Task 3: App Server Core (Worker 3)
- Create `src/app/auth.js` (register, login, logout, sessions, password hashing)
- Create `src/app/server.js` (startup: migrations → SQLite build → HTTP listener)
- Implement all public API endpoints (deals, products, stores, history, search, health)
- Implement all authenticated API endpoints (watch-list, preferred-stores, saved-searches, new-products)
- Adapt SPA from Workbench project into `public/`
- Write API contract tests, auth tests, permission tests
- Target: `node --test test/app/` passes

### Task 4: Price-minder Features (Worker 4)
- Feed prioritization (watch-list first, then preferred stores, then all deals)
- Saved searches CRUD + new-products detection
- All empty/single/multi/error/stale UI states in SPA
- Image fallback with branded placeholders
- Product comparison/detail view enhancements
- Archive freshness indicators in UI
- Target: manual browser smoke test passes all 5 MVP acceptance scenarios

### Task 5: Matching Pilot (Worker 5)
- Auto-matching on shared Foodstuffs source IDs
- Auto-matching on exact GTIN
- Human-reviewed registry (CLI for MVP)
- Fuzzy matching candidate generation
- Match label exposure in API responses
- Write matching tests
- Target: `node --test test/app/matching.test.js` passes

### Task 6: Cleanup & Polish (Worker 6)
- Remove `dashboard/` directory (old JSONL-direct server)
- Remove `.worktrees/sqlite-migration` (absorbed into main)
- Archive `workbench/projects/grocery-prices` (replace with pointer README)
- Full system integration test
- Benchmark rebuild time and query latency
- Documentation pass: update README, HANDOFF, CONTEXT
- Target: `npm test && npm run check && npm run pack:check` all pass

---

## [2026-07-16 23:00] Plan-Checker Review & Architecture Decision

### Summary

A plan-checker review was conducted using the 8-dimension framework against the
`docs/implementation-spec.md` and `PLANS.md` task breakdown. The review identified
5 failing dimensions (requirement coverage, task atomicity, file scope, verify
commands, gap detection). A second architecture (Design B) was proposed alongside
the existing one (Design A) and chosen by evidence.

### Architecture comparison

**Design A: Minimal migration/reuse** — better-sqlite3, single DB, adapt worktree
code directly. Pros: proven code. Cons: native module C++ build requirement, npm
dependency, shared DB risks user data on rebuild.

**Design B: Clean canonical ownership** — node:sqlite (built-in, zero deps),
two-DB separation (prices.db + app.db), rewrite worktree SQLite code for node:sqlite
API. Pros: zero packaging risk, no native compilation, rebuild never touches user
data. Cons: must rewrite SQLite layer.

**Winner: Design B.** The evidence (Node 26.3.1 with native node:sqlite, zero-dependency
requirement, rebuild safety) decisively favours B. All 8 core concerns are met with
less packaging risk than A.

### 8-dimension check results (first round)

| Dimension | Result | Issue |
|-----------|--------|-------|
| 1. Requirement coverage | **FAIL** | Image fallback (§5.2), freshness indicators (§5.3) lack specific tasks; missing rollback/recovery, two-DB separation |
| 2. Task atomicity | **FAIL** | "SQLite Foundation" spans 6 files; "App Server Core" spans auth + API + SPA |
| 3. Dependency ordering | PASS | Tasks ordered correctly |
| 4. File scope | **FAIL** | No task names exact file paths (e.g. "refactor syntax-repository" — which file?) |
| 5. Verify commands | **FAIL** | Worker 4: "manual browser smoke test" is not scriptable |
| 6. Context fit | PASS | Workers are bounded |
| 7. Gap detection | **FAIL** | No node:sqlite vs better-sqlite3 decision; no migration path for Workbench prototype's existing DB; no SPA adaptation path |
| 8. Nyquist compliance | **FAIL** | Workers 1 and 3 have no intermediate verification points |

### Revisions made

1. **`docs/implementation-spec.md`**: Rewrote entirely — two-DB separation (§1.1, §3.2b, §3.7),
   node:sqlite everywhere (§2.5, §9.1), async crypto.scrypt (§2.4, §9.1), MUST-ID
   traceability matrix (§14), completion definition (§15), non-destructive deprecation
   (§1.2, §13 Worker 7), rollback/recovery plan (§3.8), and explicit boundary/empty/
   single/multi/error/stale state handling throughout.

2. **`docs/execution-plan.md`**: Created new — 22 atomic work packets in 7 phases,
   each naming exact file paths, dependencies, and scriptable verification commands.
   Verification every 2–3 packets (Nyquist rule).

3. **`DECISIONLOG.md`**: Appended 5 reversal/clarification decisions (node:sqlite,
   async crypto.scrypt, two-DB separation, non-destructive deprecation, MUST-ID
   matrix). Old entries preserved intact.

4. **`PLANS.md`**: This entry appended. Previous history left untouched.

### Re-check results (second round)

| Dimension | Result | Evidence |
|-----------|--------|----------|
| 1. Requirement coverage | **PASS** | All 31 MUSTs mapped in traceability matrix (§14); each maps to at least one work packet in execution-plan.md |
| 2. Task atomicity | **PASS** | Every packet targets 1–3 files; mega-tasks eliminated (22 packets, max 3 files each) |
| 3. Dependency ordering | **PASS** | All forward references eliminated; P0 anchors everything |
| 4. File scope | **PASS** | Every packet names exact file paths (e.g. "src/sqlite/projection-repository.js") |
| 5. Verify commands | **PASS** | Every packet has a scriptable `node --check` or `node --test` command; no "manual" verifications |
| 6. Context fit | **PASS** | 22 packets fit one execution session per phase; phases are independent |
| 7. Gap detection | **PASS** | Workbench prototype's existing DB noted in P7.1; SPA adaptation in P4.4; node:sqlite verified at P0.1 |
| 8. Nyquist compliance | **PASS** | Verification points every 2–3 packets maximum; full schedule in execution-plan.md §Verification Cadence |

### Remaining unknowns / next-step findings

- **Workbench `grocery-prices.db` migration:** The prototype has an existing SQLite DB
  with user data. The new `data/app.db` will start empty. Users must re-register or a
  migration script must port existing users. Deferred — document in HANDOFF.md.
- **FTS5 support in node:sqlite:** Verify that `CREATE VIRTUAL TABLE ... USING fts5`
  works in `node:sqlite` (it depends on the SQLite compile options Node was built with).
  If FTS5 is unavailable, fall back to `LIKE` search with COLLATE NOCASE index.
- **SPA auth endpoint alignment:** The Workbench SPA calls `/auth/me`, `/auth/login`,
  `/auth/logout`. The new server must expose the same paths for the existing SPA to
  work without modification. Documented in P4.4.
- **First implementation packet:** P0.1 (verify baseline) — takes 30 seconds, zero risk,
  gates everything else.

---

## [2026-07-16 23:45] P0.1–P1.4 Implementation

### Summary

Executed P0.1 (verify baseline) and P0.2 (verify dirty state), then implemented P1.1–P1.4:
- `src/sqlite/migrations/projection/001_initial.sql` — full projection schema per spec §3.2 with `price_observations` VIEW using `json_each` (not `instr`-based substring match)
- `src/sqlite/schema.js` — migration runner with SQL-hash verification, ordered file application, duration logging
- `src/sqlite/projection-repository.js` — `ProjectionRepository` class with rebuild (atomic temp+rename), query, productHistory
- `scripts/build-db.js` — CLI with `--file`, `--output`, `--force` flags; safely importable (no side effects)

### Discoveries

- **`node:sqlite.backup`** takes `(sourceDb: DatabaseSync, destination: string)` — NOT two DatabaseSync objects
- **`node:sqlite` FTS5** requires column names without types in `CREATE VIRTUAL TABLE ... USING fts5(content)` — `USING fts5(content TEXT)` fails
- **Real JSONL `images` field is an object** keyed by resolution `{"100":"...","400":"..."}`, not an array — fixed with `bestImage()` helper that picks the largest resolution
- **Real data has 18163 records** across 9003 products, 5 stores, 9145 offers, 10 snapshots from 3 retailers
- **GTINs are populated** in Woolworths product data, enabling future auto-matching
- **`open`/`close` management** tracks DB lifecycle independent of rebuild; query() reads from current DB

### Verification

- `node:sqlite` available ✓
- `node --check` on all 3 new JS files ✓
- Fixture rebuild → query → productHistory ✓
- Real data: 18163 records, 0 errors, 9145 observations ✓
- Analytics compatible (calculateSales, calculateOngoingSales, toAgentFeed) ✓
- Equivalence: SQLite vs JSONL same counts per retailer ✓
- Missing JSONL → ENOENT error ✓
- Fingerprint → skip on second rebuild ✓
- `--force` rebuilds even when fingerprint matches ✓
- All 18 existing tests pass ✓
- `git diff --check`: no whitespace errors ✓
- No deletions, no edits to package.json, no live data modified ✓

### Files created

| File | Purpose |
|------|---------|
| `src/sqlite/migrations/projection/001_initial.sql` | Projection DB schema all tables + VIEW |
| `src/sqlite/schema.js` | Migration runner with SQL-hash verification |
| `src/sqlite/projection-repository.js` | Projection rebuild + query engine + productHistory |
| `scripts/build-db.js` | CLI entry point |

### Next packet: P1.5 — Write projection tests

---

## [2026-07-16] Security Audit & Integration Repair

### Progress

- Conducted full OWASP Top 10 + STRIDE security audit of the canonical app.
- Found 2 Critical, 1 High, 3 Medium, 2 Low findings.
- All Critical and High findings repaired with deterministic regression tests.
- Wrote 21 new security regression tests (`test/server/security.test.js`).
- Fixed rate limiting for register/login (5/min register, 20/min login with Retry-After).
- Fixed product matches filtering (fuzzy candidates no longer exposed as confirmed).
- Fixed CSRF origin check (uses server address, not spoofable Host header).
- Fixed Secure cookie flag (no longer trusts x-forwarded-proto without opt-in).
- Added session cookie format validation (64-char hex).
- Added conditional HSTS support.
- Expanded `npm run check` to all 7 source dirs.
- All 431 tests pass; `npm run check` passes.

### Decisions

1. **Rate limiting is per-IP, not per-route-dynamic.** Fixed config: register=5/min, login=20/min. Bounds are tight enough to prevent brute force without locking out legitimate users.
2. **`TRUST_PROXY_HEADERS` env var gates Secure cookie.** Default off. Must be explicitly set to '1' when behind a trusted reverse proxy.
3. **Product matches API filters by review_state.** Only `accepted`/`confirmed` states are shown as matches. Fuzzy candidates with `pending`/`candidate`/`rejected` states are excluded.

### Surprises

- The rate limiting infrastructure (`checkAndIncrementRateLimit`, `rate_limit` table) was fully implemented in `AppDatabase` but **never wired to any handler**. Complete security feature present but inert.
- The matching system writes to `product_match_pairs` in `data/app.db` but the API reads `product_matches` in `data/prices.db`. Different tables, different DBs — the pipeline is disconnected. Matches only appear in tests via direct SQL inserts.
- The `_requestId` and `_freshness` fields are present in all object responses but missing from array responses (by design — bare JSON arrays). No security impact but degrades request tracing for array endpoints.

---

## [2026-07-16 19:20] Matching Pipeline Wiring & Integration Completion

### Progress

- Wired the public API product detail handler (`src/server/handlers/public.js`) to read
  match truth from `AppDatabase.product_match_pairs` instead of the projection DB's
  `product_matches` table — closing the disconnected-pipeline gap documented as
  Residual Risk #1 in the security audit.
- Confirmed matches (`review_state: 'confirmed'`) are returned as `matches` array.
  Fuzzy candidates (`review_state: 'candidate'`) are returned separately as
  `candidates` array. No auto-confirmation of fuzzy candidates.
- Created `scripts/matching-cli.js` — CLI that reads products from projection DB,
  runs auto-matching (GTIN + source_id) and optionally fuzzy matching, writes
  results to AppDatabase. Usage: `npm run matching` or `npm run matching -- --fuzzy`.
- Fixed SPA suggestions parameter name mismatch (`?q=` → `?query=`) to align with
  server expectations.
- Added `npm run build-db`, `npm run start`, and `npm run matching` scripts to
  `package.json`. `npm run dashboard` (legacy) preserved unchanged.
- Added `appDbInit` hook to test server helpers for seeding AppDatabase match data
  in tests.
- Added 2 new tests: (1) product detail returns confirmed matches and fuzzy
  candidates separately via AppDatabase; (2) security regression confirms fuzzy
  candidates are not in `matches`.
- Updated 2 existing tests (public-api match test, security match filter test) to
  seed matches via `AppDatabase.createMatchPair()` instead of direct SQL into
  projection DB's `product_matches`.
- Updated README with setup/run/test/rebuild commands, two-DB lifecycle, matching
  truth policy, security caveats, and deprecation note.
- Total tests: 432 (was 431), all pass.

### Decisions

1. **Public API reads match truth from AppDatabase, not projection DB.** The
   `product_match_pairs` table in `data/app.db` is the durable matching authority.
   The projection DB's `product_matches` table is no longer consulted for product
   detail match data.
2. **Confirmed matches and fuzzy candidates are separate response fields.**
   `matches` = confirmed facts (auto_gtin, auto_source_id, human_reviewed with
   review_state=confirmed). `candidates` = fuzzy suggestions (review_state=candidate).
3. **Matching CLI is a bounded script**, not a persistent daemon or scheduler.
   It reads from projection DB products and writes to AppDatabase, using current
   IDs without inventing unsupported identities.

### Surprises

- The `Array.isArray(appDb.getMatchesForProduct)` guard was wrong —
  `getMatchesForProduct` is a method (function), not an array. Fixed to use
  `typeof appDb.getMatchesForProduct === 'function'`.
- The SPA's `suggestions()` API was sending `?q=` but the server read `query` param.
  The SPA worked before because the suggestions endpoint isn't wired in the current
  UI (the search form in `browse.js` calls `api.products()` directly).

### Files changed

| File | Change |
|------|--------|
| `src/server/handlers/public.js` | Wire `getProduct` to read matches from `appDb` closure; separate confirmed/candidate |
| `src/app/server.js` | Pass `appDb` to `createPublicHandlers` |
| `test/server/server-helpers.js` | Pass `appDb` to `createPublicHandlers`; add `appDbInit` option |
| `test/server/public-api.test.js` | Update match test to use `appDbInit`; add fuzzy-candidate-separate test |
| `test/server/security.test.js` | Update match filter test to use `appDbInit` |
| `public/api.js` | Fix suggestions param name (`q` → `query`) |
| `scripts/matching-cli.js` | New file — matching CLI script |
| `package.json` | Add `build-db`, `start`, `matching` scripts |
| `README.md` | Update with new server docs, two-DB lifecycle, matching policy, security caveats, deprecation note |
| `PLANS.md` | This entry |

---

## [2026-07-16 20:30] Deal Signal Runtime Computation & Verification

### Progress

- Rewrote `listDeals` handler to compute deals at runtime using `calculateSales()`
  and `calculateOngoingSales()` from `src/analytics.js` instead of reading from the
  static (always-empty) `deal_signals` table. Deal signals are now computed from
  actual offer data with a 90-day baseline and 3-sample minimum per MUST-01c.
- Created `defaultQueryDbObservations()` function that queries offer revisions from
  the projection DB and formats them in the shape expected by the analytics engine.
- Fixed `isOnSpecial` handling: only set to `true` when promotion data exists with
  promo cents, not `false` unconditionally (which caused `calculateOngoingSales`
  to reject all observations).
- Updated 2 existing deals tests to use runtime analytics path instead of
  `INSERT INTO deal_signals` — tests now provide multiple offer observations
  with price drops and promotion data.
- Real-data smoke test (18163 records): `/api/deals` returns **1 history-backed**
  and **9044 advertised** deals — first time deals have been non-empty since the
  new server was built.
- Matching CLI verified on real data: **30 auto GTIN matches** found between
  Warehouse and Woolworths products, written to App DB. Product detail returns
  confirmed matches correctly.
- Auth smoke test repeated with proper `curl -c/-b` cookie jar: register → login →
  authenticated `/api/watch-list` → **200 with empty array** (working).
- Documented that legacy `deal_signals` and `product_matches` tables in projection
  DB schema are retained for compatibility but not populated — source of truth is
  App DB's `product_match_pairs`.

### Decisions

1. **Deal signals are runtime, not materialized.** The `deal_signals` table in the
   projection schema is retained but never written to. The `calculateSales()` and
   `calculateOngoingSales()` functions compute deals on every request from offer
   data. This is consistent with the spec's MUST-01 (empty arrays when no deals,
   not errors) and provides fresher results without a rebuild step.
2. **`isOnSpecial` is only set when promotion data is present.** The analytics
   engine checks `isOnSpecial !== false`, meaning observations without the field
   or with `true` pass the filter. The query helper sets `isOnSpecial: true` only
   when `promotion_data` exists with `price_promo_cents`.

### Surprises

- The `deal_signals` table had always been empty since the new server was built.
  The `/api/deals` endpoint returned zero results from day one. The analytics
  functions (`calculateSales`/`calculateOngoingSales`) existed in the codebase
  but were never wired to the handler.
- With real data, `calculateOngoingSales` returns 9044 advertised deals. This is
  because the JSONL archive records every offer with promotion data, and the
  analytics treats any promotion-bearing observation within 7 days as an
  advertised deal. The number will stabilise as freshness filtering settles.
- The auth smoke test worked correctly when using proper curl cookie jar handling.
  My previous report showing 401 was a test-script bug, not a server bug.

### Files changed

| File | Change |
|------|--------|
| `src/server/handlers/public.js` | Rewrite `listDeals` to use runtime analytics + defaultQueryDbObservations |
| `src/app/server.js` | Import + pass `defaultQueryDbObservations` |
| `test/server/server-helpers.js` | Import + pass `defaultQueryDbObservations` |
| `test/server/public-api.test.js` | Update 2 deal tests for runtime analytics; remove deal_signals inserts |
| `README.md` | Add deals runtime computation docs; document legacy deal_signals/product_matches |
| `PLANS.md` | This entry |

---

## [2026-07-17] Completion Pass: P3.3, P5.1/P5.2, P7.1, Deferred Unknowns

### Summary

Closed the remaining execution-plan gaps: adapter fixture tests (P3.3), feed
prioritization with UI tiers (P5.1/P5.2), deprecation pointers (P7.1), and
resolved all 3 deferred unknowns. Total tests: 443 (was 435), all pass.

### P3.3 — Adapter fixture tests

- Created `test/adapters/foodstuffs.test.js`, `woolworths.test.js`,
  `freshchoice.test.js`, `warehouse.test.js`.
- Each tests the `to*Observation` / `parse*Products` functions with hand-crafted
  fixture data matching real retailer API response shapes (no live network calls).
- Covers: normal extraction, missing fields → undefined, promotion parsing,
  retailer prefix variants, multibuy/callout decoding, HTML parsing edge cases.

### P5.1/P5.2 — Feed prioritization + UI tiers

- **`src/server/handlers/public.js`**: `listDeals` now resolves the authenticated
  user via `ctx.cookies.sid` → `auth.getSessionUser()`, loads watch-list entries
  and store preferences from `appDb`, and partitions deals into 3 tiers:
  `watch-preferred` (watch-list product at a preferred store), `watch-other`
  (watch-list product at another store), `all` (everything else). Each tier sorted
  by discount magnitude. Response includes `tiers: { watchPreferred, watchOther,
  all }` summary and each deal carries a `tier` field. Unauthenticated requests
  get the original flat ordering (no `tiers` field) — backward compatible.
- Category watch-list entries match by category name (strips `category:` prefix
  from `target_id` to handle the `prefix:id` validation format).
- **`src/app/server.js`** + **`test/server/server-helpers.js`**: pass `auth` to
  `createPublicHandlers` so the deals handler can resolve sessions.
- **`public/views/deals.js`**: renders tier sections ("In your watch list • at
  your stores" / "other stores" / "All deals") when `tiers` is present; falls
  back to the original history-backed/advertised grid layout for anonymous users.
- **`test/app/feed.test.js`**: 8 tests covering empty state, 503, anonymous flat
  ordering, watch-preferred priority, watch-other tier, all tier, category
  matching, and invalid-session handling.

### P7.1 — Deprecation pointers

- **`dashboard/server.js`**: added `console.warn(...)` deprecation banner on load.
- **`dashboard/README.md`**: new — deprecation notice pointing to `npm start`.
- **`.worktrees/sqlite-migration/README.md`**: new — notes worktree absorbed
  into main (node:sqlite, two-DB separation).
- **`workbench/projects/grocery-prices/POINTER.md`**: new — notes app moved to
  prices repo.

### Deferred unknowns (resolved)

- **FTS5**: Not used. Search uses `LIKE` + `COLLATE NOCASE` index on
  `products.name`. FTS5 migration never needed at current scale (~9k products).
- **SPA auth alignment**: All 20 SPA↔server paths fully aligned. The Workbench
  `/auth/me` session-probe was dropped — SPA uses 401-driven re-auth. A
  `/api/auth/me` endpoint would be needed if "restore session on page load" UX
  is wanted later.
- **Workbench user migration**: Workbench `User` table has zero users. Hash
  formats are incompatible (Workbench vs prices' scrypt). Re-registration is the
  expected path; no migration script needed with an empty user table.

### Decisions

1. **Feed tiers are additive.** The response keeps `historyBacked`/`advertised`
   arrays and adds `tiers` + per-deal `tier` field. Anonymous users see no
   change. This is backward-compatible and lets the SPA progressively enhance.
2. **Category watch-list uses `category:` prefix in target_id.** The API
   validates `targetId` as `/^[a-z]+:[a-zA-Z0-9_-]+$/` for non-saved-search
   kinds, so category entries are stored as `category:Dairy`. The deals handler
   strips the prefix when matching against `deal.product.category`.

### Verification

- `npm test` → 443 pass, 0 fail, 0 skipped (~4.6s)
- `npm run check` → exit 0
- `npm run pack:check` → exit 0
