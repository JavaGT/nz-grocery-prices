# Implementation Specification: NZ Grocery Price Intelligence

**Date:** 2026-07-16
**Status:** Draft — ready for implementation (post plan-checker review)
**Ownership:** Single repo at `/Users/server/Code/prices`

---

## 1. Overview & System Ownership

### 1.1 Architectural principle

**JSONL is authoritative and lossless; SQLite is a rebuildable read-only projection.** Every collected fact lives first in `data/prices.jsonl` (v2 change-only format). The SQLite projection database at `data/prices.db` is a deterministic materialization of the JSONL archive, rebuilt on demand and never written to directly by collectors. This preserves the append-only audit trail and makes the price projection disposable.

**Two-DB separation:** A separate application database `data/app.db` stores user data (accounts, sessions, store preferences, watch lists, saved searches) that MUST survive projection rebuilds. The projection DB holds only the price data deterministically derived from JSONL; the app DB holds user state that is not derived from JSONL. Rebuilding the projection MUST never touch `data/app.db`. See §3.7.

**Zero dependencies for SQLite:** Node.js 26.3.1 provides `node:sqlite` as a built-in module (`DatabaseSync`, `StatementSync`). No npm package is needed for SQLite. This eliminates the native compilation requirement of `better-sqlite3` and reduces packaging risk to zero.

### 1.2 Repo ownership

All application code, SQLite projection code, and the SPA frontend move into `/Users/server/Code/prices`. The Workbench prototype at `/Users/server/Code/workbench/projects/grocery-prices` is kept in place as a read-only reference; it has NOT been archived. The `prices` repo owns:

| Component | Location | Owned by |
|-----------|----------|----------|
| Price collection (all adapters) | `src/adapters/` | prices repo |
| JSONL archive (authoritative) | `data/prices.jsonl` | prices repo |
| Archive operations (read, compact) | `src/repository.js`, `src/archive.js` | prices repo |
| Analytics (sales, signals, feed) | `src/analytics.js` | prices repo |
| SQLite read projection | `src/sqlite/projection-repository.js` | prices repo |
| SQLite schema + migrations | `src/sqlite/schema.js` | prices repo |
| SQLite rebuild CLI | `scripts/build-db.js` | prices repo |
| Application state DB (auth, prefs) | `src/sqlite/app-db.js` | prices repo |
| App server (HTTP API) | `src/app/server.js` | prices repo |
| App auth (sessions via app DB) | `src/app/auth.js` | prices repo |
| SPA frontend (price•minder) | `public/` | prices repo |
| Adapter fixture tests | `test/adapters/` | prices repo |
| SQLite + app tests | `test/sqlite/`, `test/app/` | prices repo |
| Daily archive runner | `scripts/archive-daily-local.sh` | prices repo |
| LaunchDaemon template | `ops/` | prices repo |

The old `dashboard/` directory (JSONL-direct server) is deprecated. After the new `src/app/` server passes all integration contract tests, the old dashboard entry point becomes a deprecation notice. The directory and its files are NEVER deleted; they remain as a preserved reference.

### 1.3 Boundary between prices and Workbench

The `prices` repo is fully self-contained. All runtime dependencies are in its own `package.json`. No import paths cross into `workbench/`. The Workbench project at `workbench/projects/grocery-prices` is kept as a read-only historical reference, not archived or deleted.

---

## 2. Architecture & Data Flow

### 2.1 End-to-end data flow

```
Retailer APIs
     ↓ (adapters collect)
data/prices.jsonl  ←── authoritative, append-only JSONL
     ↓ (scripts/build-db.js or app startup)
data/prices.db     ←── rebuildable read projection (SQLite, WAL mode, node:sqlite)
     ↓ (src/app/server.js reads via src/sqlite/projection-repository.js)
HTTP API (JSON)    ←── public + authenticated endpoints
     ↓
SPA frontend       ←── public/ (price•minder brand)

data/app.db        ←── persistent user data (NEVER rebuilt from JSONL)
     ↑ (src/sqlite/app-db.js manages auth, sessions, prefs, watch, searches)
```

### 2.2 SQLite rebuild strategy

- **Deterministic rebuild:** `src/sqlite/projection-repository.js` computes a SHA-256 fingerprint of the JSONL file contents. If `_meta.jsonl_fingerprint` matches, SQLite is up-to-date. If not, a full rebuild occurs.
- **Incremental import (future):** The fingerprint approach is all-or-nothing for correctness. An incremental mode may be added later by tracking the byte offset of the last imported record in `_meta.last_imported_offset`. This is deferred until measured rebuild time for the production archive exceeds 30 seconds.
- **Rebuild is atomic:** A rebuild is wrapped in a single SQLite transaction. On failure, the DB retains its previous state. On success, the fingerprint is updated. The backup API (`node:sqlite.backup`) MAY be used for safe checkpointing.
- **Concurrent rebuilds:** Two processes attempting rebuild simultaneously: SQLite `EXCLUSIVE` transaction on WAL mode causes one to fail. The app MUST catch this and serve from the existing DB.
- **Projection DB is disposable:** `data/prices.db` can be deleted and rebuilt from JSONL at any time. It contains NO user data. All auth/session/preference/watch/search data lives in `data/app.db`.

### 2.3 App server startup sequence

1. Open SQLite at `data/app.db` (create if absent) — this DB is NEVER rebuilt
2. Open SQLite at `data/prices.db` (create if absent) — projection DB
3. Apply pending migrations to both DBs (see §3.3)
4. Check JSONL fingerprint — rebuild SQLite projection if stale
5. Start HTTP listener
6. Serve 503 during migration; never serve on partial schema

### 2.4 Session/auth architecture

Local-first, multi-user (Workbench-style):
- Sessions stored in SQLite `sessions` table (in `data/app.db`) with expiry
- HTTP-only `sid` cookie
- Username/password hashing via Node.js `crypto.scrypt` (async, with salt 16 bytes, N=16384, r=8, p=1). The async variant MUST be used on HTTP request paths — `crypto.scryptSync` blocks the event loop and must NOT be used in request handlers.
- No email verification, no password recovery (deferred)
- Rate limiting: 120 req/min per IP, 300 req/min per session

### 2.5 SQLite driver choice: node:sqlite

Node.js 26.3.1 provides `node:sqlite` (`DatabaseSync`, `StatementSync`, `backup`) as a built-in module. This is used instead of `better-sqlite3` for the following reasons:

| Criterion | better-sqlite3 | node:sqlite (built-in) |
|-----------|---------------|----------------------|
| npm dependency | Yes | Zero |
| Native compilation | Required (C++ toolchain) | None |
| Synchronous API | Yes | Yes |
| WAL mode | Yes | Yes |
| Prepared statements | Yes | Yes |
| Backup API | Yes (extension) | Yes (built-in) |
| Available now | Install required | Available immediately |

Decision: Use `node:sqlite`. Zero packaging risk, zero build toolchain requirement.

---

## 3. SQLite Schema, Key Constraints & Migrations

### 3.1 Schema versioning

- A `schema_migrations` table records every applied migration by name + SQL hash + applied timestamp (one per DB)
- Migrations are ordered, idempotency-checked (INSERT OR IGNORE into schema_migrations)
- The app applies pending migrations at startup BEFORE fingerprint check or HTTP listener
- Migration failure = process exit (never serve on partial schema)
- Initial schema version: `001_initial` for projection DB; `001_app_auth` for app DB

### 3.2 Initial tables — Projection DB (`001_initial` in `data/prices.db`)

```sql
-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  sql_hash    TEXT NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Import provenance
CREATE TABLE IF NOT EXISTS import_runs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  jsonl_path      TEXT NOT NULL,
  jsonl_hash      TEXT NOT NULL,
  jsonl_size      INTEGER NOT NULL,
  records_imported INTEGER NOT NULL DEFAULT 0,
  errors          INTEGER NOT NULL DEFAULT 0,
  error_detail    TEXT,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  status          TEXT NOT NULL CHECK(status IN ('running','completed','failed'))
);

-- Retailer identity
CREATE TABLE IF NOT EXISTS retailers (
  id          TEXT PRIMARY KEY,          -- slug: 'paknsave', 'newworld', 'woolworths', 'freshchoice', 'warehouse'
  name        TEXT NOT NULL,
  website     TEXT
);

-- Price contexts (exact collection scope)
CREATE TABLE IF NOT EXISTS price_contexts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  retailer_id   TEXT NOT NULL REFERENCES retailers(id),
  store_id      TEXT NOT NULL,           -- retailer's store identifier
  store_name    TEXT NOT NULL,
  scope_kind    TEXT NOT NULL CHECK(scope_kind IN ('physical-store','fulfilment-store','store-site','national-online')),
  address       TEXT,
  region        TEXT,
  UNIQUE(retailer_id, store_id)
);

-- Products: current indexed state (always latest revision)
CREATE TABLE IF NOT EXISTS products (
  id              TEXT NOT NULL,         -- e.g. 'paknsave:12345'
  retailer_id     TEXT NOT NULL REFERENCES retailers(id),
  name            TEXT NOT NULL,
  brand           TEXT,
  category        TEXT,
  image_url       TEXT,
  size            TEXT,                  -- e.g. '1kg', '2L'
  source_id       TEXT,                  -- retailer's product ID (shared Foodstuffs IDs enable auto-match)
  gtin            TEXT,                  -- GTIN/UPC for exact cross-retailer matching
  latest_hash     TEXT NOT NULL,         -- SHA-256 of latest revision data
  first_seen_at   INTEGER NOT NULL,      -- epoch ms
  updated_at      INTEGER NOT NULL,      -- epoch ms
  PRIMARY KEY (id, retailer_id)
);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_products_source ON products(source_id);
CREATE INDEX IF NOT EXISTS idx_products_gtin ON products(gtin);

-- Product revisions (immutable)
CREATE TABLE IF NOT EXISTS product_revisions (
  hash          TEXT PRIMARY KEY,        -- SHA-256 of stable-json(product data)
  product_id    TEXT NOT NULL,
  retailer_id   TEXT NOT NULL,
  data          TEXT NOT NULL,           -- full product metadata blob
  observed_at   INTEGER NOT NULL         -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_pr_product ON product_revisions(product_id, observed_at DESC);

-- Store revisions (immutable)
CREATE TABLE IF NOT EXISTS store_revisions (
  hash          TEXT PRIMARY KEY,        -- SHA-256 of stable-json(store data)
  context_id    INTEGER NOT NULL REFERENCES price_contexts(id),
  data          TEXT NOT NULL,           -- full store metadata blob
  observed_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sr_context ON store_revisions(context_id, observed_at DESC);

-- Offer revisions (immutable price/promotion records)
CREATE TABLE IF NOT EXISTS offer_revisions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_key         TEXT NOT NULL,       -- product_id + \x00 + context_id
  product_id        TEXT NOT NULL,
  context_id        INTEGER NOT NULL REFERENCES price_contexts(id),
  product_rev_hash  TEXT REFERENCES product_revisions(hash),
  store_rev_hash    TEXT REFERENCES store_revisions(hash),
  rev_hash          TEXT NOT NULL,       -- SHA-256 of stable-json(price+promotion+source)
  price_regular_cents  INTEGER NOT NULL CHECK(price_regular_cents >= 0),
  price_promo_cents    INTEGER CHECK(price_promo_cents IS NULL OR price_promo_cents >= 0),
  price_member_cents   INTEGER CHECK(price_member_cents IS NULL OR price_member_cents >= 0),
  comparative       TEXT,                -- JSON object {measure, measureUnit, measureDescription}
  promotion_data    TEXT,                -- JSON object {id, type, savePercent, ...}
  source_data       TEXT NOT NULL,       -- JSON object {adapter, url, ...}
  observed_at       INTEGER NOT NULL,    -- epoch ms
  UNIQUE(offer_key, rev_hash, observed_at)
);
CREATE INDEX IF NOT EXISTS idx_or_product ON offer_revisions(product_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_or_context ON offer_revisions(context_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_or_offer_key ON offer_revisions(offer_key, observed_at DESC);

-- Special listing snapshots (advertised-specials state per store)
CREATE TABLE IF NOT EXISTS special_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  context_id    INTEGER NOT NULL REFERENCES price_contexts(id),
  observed_at   INTEGER NOT NULL,
  offers_hash   TEXT NOT NULL,          -- hash of the offer set
  offer_count   INTEGER NOT NULL,
  added         TEXT NOT NULL,           -- JSON array of offer_key strings
  removed       TEXT NOT NULL            -- JSON array of offer_key strings
);
CREATE INDEX IF NOT EXISTS idx_ss_time ON special_snapshots(context_id, observed_at DESC);

-- Price observations (query projection of offer history, integer cents only)
CREATE VIEW price_observations AS
SELECT
  or2.offer_key,
  or2.product_id,
  or2.context_id,
  or2.rev_hash,
  or2.price_regular_cents,
  or2.price_promo_cents,
  or2.price_member_cents,
  or2.observed_at,
  CASE
    WHEN ss.id IS NOT NULL AND ss.observed_at >= or2.observed_at THEN 1
    ELSE 0
  END AS is_on_special,
  ss.observed_at AS last_special_seen_at
FROM offer_revisions or2
LEFT JOIN special_snapshots ss ON ss.context_id = or2.context_id
  AND ss.observed_at >= or2.observed_at
  AND json_valid(ss.added) AND instr(ss.added, or2.offer_key) > 0;

-- Product cross-retailer matching (auditable)
CREATE TABLE IF NOT EXISTS product_matches (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  product_a_id      TEXT NOT NULL,
  product_a_retailer TEXT NOT NULL,
  product_b_id      TEXT NOT NULL,
  product_b_retailer TEXT NOT NULL,
  match_method      TEXT NOT NULL CHECK(match_method IN ('auto_gtin','auto_source_id','human_reviewed','fuzzy_candidate')),
  confidence        REAL CHECK(confidence >= 0 AND confidence <= 1),
  review_state      TEXT NOT NULL DEFAULT 'pending' CHECK(review_state IN ('pending','accepted','rejected')),
  reviewer          TEXT,                -- user ID who reviewed
  reviewed_at       TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE(product_a_id, product_b_id)
);

-- Deal signals (rebuildable price-history conclusions)
CREATE TABLE IF NOT EXISTS deal_signals (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id          TEXT NOT NULL,
  context_id          INTEGER NOT NULL REFERENCES price_contexts(id),
  signal_kind         TEXT NOT NULL CHECK(signal_kind IN ('history_drop','all_time_low','advertised_only')),
  calc_version        TEXT NOT NULL,     -- analytics algorithm version
  baseline_window_days INTEGER NOT NULL,
  min_samples         INTEGER NOT NULL,
  price_policy        TEXT NOT NULL,
  reference_cents     INTEGER NOT NULL,
  current_cents       INTEGER NOT NULL,
  drop_percent        REAL,
  calculated_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ds_product ON deal_signals(product_id, context_id);
```

### 3.2b Initial tables — Application DB (`001_app_auth` in `data/app.db`)

This database is NEVER rebuilt from JSONL. It is created once and migrated forward.

```sql
-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  sql_hash    TEXT NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- User accounts
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,          -- random token
  user_id       INTEGER NOT NULL REFERENCES users(id),
  expires_at    INTEGER NOT NULL,          -- epoch ms
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

-- User-store preferences (ranked price contexts)
CREATE TABLE IF NOT EXISTS user_store_preferences (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  context_id    INTEGER NOT NULL,          -- FK to prices.db price_contexts, validated at write
  rank          INTEGER NOT NULL CHECK(rank >= 0),
  UNIQUE(user_id, context_id)
);
CREATE INDEX IF NOT EXISTS idx_usp_user ON user_store_preferences(user_id, rank);

-- Saved searches (named private search criteria)
CREATE TABLE IF NOT EXISTS saved_searches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  name            TEXT NOT NULL,
  query_text      TEXT NOT NULL,         -- the search string
  retailer_filter TEXT,                  -- optional retailer slug
  category_filter TEXT,                  -- optional category
  normalized_hash TEXT NOT NULL,         -- SHA-256 of normalized search for dedup
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(user_id, normalized_hash)
);
CREATE INDEX IF NOT EXISTS idx_ss_user ON saved_searches(user_id);

-- Watch list entries
CREATE TABLE IF NOT EXISTS watch_list_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  target_kind   TEXT NOT NULL CHECK(target_kind IN ('product','category','saved_search')),
  target_id     TEXT NOT NULL,           -- product ID, category name, or saved_search ID
  label         TEXT NOT NULL,           -- human-readable label for display
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(user_id, target_kind, target_id)
);
CREATE INDEX IF NOT EXISTS idx_wle_user ON watch_list_entries(user_id);

-- Newly observed products (for "new products" discovery)
CREATE TABLE IF NOT EXISTS new_product_notices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    TEXT NOT NULL,
  retailer_id   TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  notified      INTEGER NOT NULL DEFAULT 0,  -- 0 = unseen by user
  UNIQUE(product_id, retailer_id)
);

-- Rate limiting counters
CREATE TABLE IF NOT EXISTS rate_limit (
  bucket_key    TEXT NOT NULL,           -- 'ip:<addr>' or 'session:<sid>'
  window_start  INTEGER NOT NULL,        -- epoch ms
  count         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (bucket_key, window_start)
);
```

### 3.3 Migration policy

- Each migration is a numbered SQL file in `src/sqlite/migrations/` (e.g. `001_initial.sql`, `001_app_auth.sql`)
- Projection DB migrations are in `src/sqlite/migrations/projection/`
- App DB migrations are in `src/sqlite/migrations/app/`
- The migration runner reads them in order, applies each not yet in `schema_migrations`
- Migration files are immutable once merged; corrections are new migration files
- After applying all pending migrations to both DBs, the app proceeds to fingerprint check + HTTP listener

### 3.4 Index justification

| Index | Justification |
|-------|--------------|
| `idx_products_name` | Text search with COLLATE NOCASE |
| `idx_products_source` | Auto-matching via shared Foodstuffs source IDs |
| `idx_products_gtin` | Auto-matching via exact GTIN |
| `idx_pr_product` | Product history queries |
| `idx_sr_context` | Store revision lookup |
| `idx_or_product` | Product-centric queries (detail page, history) |
| `idx_or_context` | Store-centric queries (all offers at a store) |
| `idx_or_offer_key` | Offer dedup + latest-offer query |
| `idx_ss_time` | Snapshot reconstruction by time |
| `idx_ds_product` | Deal signal queries |
| `idx_usp_user` | User preference queries |
| `idx_ss_user` | Saved search queries |
| `idx_wle_user` | Watch list queries |
| `idx_sessions_expiry` | Session cleanup queries |

**FTS5:** Added as migration `002_fts_product_search` after initial data is imported. The FTS5 virtual table indexes product name, brand, category, and description. It is rebuilt on product changes.

### 3.5 JSONL fallback and recovery

- If SQLite is absent or corrupt, the server MAY fall back to reading JSONL directly via `JsonlObservationRepository`, but MUST log a prominent warning
- This fallback is degraded: no FTS5 search, no watch-list/preference integration, no deal signals
- Recovery: re-run `scripts/build-db.js` or restart the server (which triggers rebuild)

### 3.6 Benchmark

- After initial build, measure: `time node scripts/build-db.js` for the production archive
- Target: rebuild in under 10s for ≤100K JSONL lines
- Log import duration in `import_runs` table

### 3.7 Two-DB separation: rationale and safety

The spec mandates separate `data/prices.db` (projection) and `data/app.db` (application state):

| Concern | Single DB | Two DBs |
|---------|-----------|---------|
| Rebuild destroys user data | Possible if rebuild query misses exclusion | Impossible — app DB is never touched |
| Schema migration complexity | One sequence | Two sequences (parallel, both checked) |
| Concurrent access isolation | Shared WAL | Independent WAL per DB |
| Backup/restore clarity | Which tables to exclude? | Obvious — projection is disposable |
| Connection overhead | One connection | Two connections |

Decision: **Two DBs**. The projection build (`scripts/build-db.js` and startup rebuild) MUST only open `data/prices.db`. It MUST NOT open or modify `data/app.db`. The app server opens both.

### 3.8 Rollback and recovery

- **Schema migration failure:** If any migration fails to apply, the process exits immediately. The database is left in its pre-migration state (migrations are applied inside transactions). Manual recovery: fix the migration file, restart.
- **JSONL rebuild failure:** If rebuild fails mid-transaction, the transaction rolls back and the existing (`data/prices.db`) is preserved. A warning is logged with the error details. The server continues serving from the previous DB.
- **Malformed JSONL line:** If a JSONL line cannot be parsed, it is skipped with a logged warning (including file path and line number). Rebuild continues with remaining lines. The `import_runs.errors` counter is incremented.
- **Missing JSONL:** If `data/prices.jsonl` does not exist, the server starts in degraded mode (no projection DB) and falls back to `JsonlObservationRepository`.
- **Stale/missing archive:** The `_freshness` field in every API response indicates whether collection data exists and its age. The frontend renders the appropriate stale state.
- **Corrupt SQLite:** If `data/prices.db` fails to open (SQLITE_CORRUPT), delete it and rebuild. If `data/app.db` is corrupt, the process exits — manual recovery via schema re-creation is required but user data loss may occur (backup `data/app.db` regularly).

---

## 4. API Design

### 4.1 Public endpoints (no auth required)

All public endpoints are mounted at `/api/`.

#### `GET /api/deals` [MUST-01]
Returns shaped deal feed.
- Query params: `filter` (history-backed|advertised|all), `limit` (default 120, max 200), `retailer`
- Response: `{ historyBacked: [...], advertised: [...], stale: boolean, archiveFreshness: { latestCollection: string, totalStores: number, storesWithData: number } }`
- Each deal includes: product id/name/image, price context label, cents (regular + effective), signal label, drop percent, savings text, retailer badge
- MUST return empty arrays, not error, when no deals match [MUST-01a]
- MUST include archiveFreshness to enable stale-state UI [MUST-01b]
- MUST NOT show history-backed signals for products with insufficient history (< minSamples) [MUST-01c]
- MUST NOT fabricate baseline data [MUST-01d]

#### `GET /api/products` [MUST-02]
Search products.
- Query params: `query` (text search, max 200 chars), `retailer`, `limit` (default 42, max 200), `offset`
- Response: `{ products: [...], total: number, limit: number, offset: number }`
- Empty query returns most recently updated products (reverse chronological)
- MUST return empty products array, not 404, when no matches [MUST-02a]
- MUST reject queries > 200 chars with 400 [MUST-02b]
- MUST validate all query params with 400 on constraint violation [MUST-02c]

#### `GET /api/products/:productId` [MUST-03]
Product detail with all known offers across stores.
- Response: `{ product: {...}, offers: [{ priceContext, cents, isOnSpecial, lastSeenAt, historyUrl }], matches: [...]}`
- MUST handle single-offer state: show single offer, no comparison table [MUST-03a]
- MUST handle no-offer state: return product metadata with empty offers array and helpful message [MUST-03b]
- MUST handle multi-offer state: show comparison across all retailer/store combinations [MUST-03c]
- `matches` contains cross-retailer matches with match label (auto_gtin / auto_source_id / human_reviewed / fuzzy_candidate)

#### `GET /api/products/:productId/history` [MUST-04]
Price history for one product at one store.
- Query params: `contextId` (required), `limit` (default 365)
- Response: `{ productId, contextId, history: [{ cents, observedAt, isOnSpecial }], sparkline: [{ x, y }] }`
- MUST return 404 if product not found [MUST-04a]
- MUST return empty history array, not 404, if product exists but has no offers at that context [MUST-04b]

#### `GET /api/stores` [MUST-05]
All distinct price contexts.
- Response: `{ stores: [{ contextId, retailerId, storeName, scopeKind, address, region }] }`

#### `GET /api/search/suggestions` [MUST-06]
Quick autocomplete-style product name suggestions.
- Query params: `q` (min 2 chars, max 100)
- Response: `{ suggestions: [{ productId, name, brand, imageUrl }] }`

#### `GET /api/health` [MUST-07]
Health check: `{ status: 'ok', db: 'sqlite'|'jsonl_fallback', schemaVersion, rebuildRequired, lastImportMs }`

### 4.2 Authenticated endpoints (auth required, HTTP-only `sid` cookie)

#### `GET /api/watch-list` [MUST-08]
User's watch list with current deal status for each entry.
- Response entries include: product image/name, best current price, signal if any
- Prioritized: entries matching preferred stores shown first
- MUST return 401 if not authenticated [MUST-08a]
- MUST return empty array, not error, when watch list is empty [MUST-08b]

#### `POST /api/watch-list` [MUST-09]
Add watch list entry. Body: `{ targetKind, targetId, label }`
- MUST reject with 400 if targetKind is invalid [MUST-09a]
- MUST reject with 400 if targetId is empty [MUST-09b]

#### `DELETE /api/watch-list/:entryId` [MUST-10]
Remove watch list entry.
- MUST return 404 if entry not found or not owned by user [MUST-10a]
- MUST NOT allow deleting another user's entries [MUST-10b]

#### `GET /api/preferred-stores` [MUST-11]
User's ranked store preferences.
- Response: ordered by rank ascending

#### `POST /api/preferred-stores` [MUST-12]
Add/update preferred store. Body: `{ contextId, rank }`
- MUST validate contextId exists [MUST-12a]
- MUST allow rank 0 (remove from preferred) as equivalent to DELETE [MUST-12b]

#### `DELETE /api/preferred-stores/:contextId` [MUST-13]
Remove a preferred store.

#### `GET /api/saved-searches` [MUST-14]
User's saved searches.

#### `POST /api/saved-searches` [MUST-15]
Create saved search. Body: `{ name, queryText, retailerFilter?, categoryFilter? }`
- MUST normalize query text and detect duplicates per user [MUST-15a]
- MUST reject with 400 if name or queryText is empty [MUST-15b]
- MUST reject names > 100 chars [MUST-15c]

#### `DELETE /api/saved-searches/:searchId` [MUST-16]
Delete a saved search.
- MUST return 404 if not found or not owned by user [MUST-16a]

#### `GET /api/new-products` [MUST-17]
Products first seen since last visit, optionally filtered by preferred stores.
- Response: `{ products: [...], lastCheckedAt: string }`
- Clears the "new" flag for the user on successful fetch

### 4.3 Feed prioritization

The global feed (`GET /api/deals`) prioritizes:
1. Watch-list products that match preferred stores → highest visibility
2. Watch-list products at other stores → second tier
3. All other deals → standard display

Each tier is sorted by discount magnitude descending. The UI renders tiers with visual boundaries (e.g. "In your watch list" / "At your stores" / "All deals").

---

## 5. UI Behavior (price·minder SPA)

### 5.1 States for every data view

| View | Empty state | Single-item state | Multi-item state | Error state | Stale state |
|------|-----------|-------------------|------------------|-------------|-------------|
| Homepage deals | "No current deals — collection in progress" banner with next-check-time | Single deal card in grid (no pagination) | Grid of deal cards | "Could not load deals" with retry button | Banner: "Latest prices from {date}" if >24h old |
| Product detail | Product metadata + "No offers collected yet" message | Single offer card (no comparison) | Offer comparison table | "Could not load product" | Stale badge on offer cards |
| Product history | Empty chart + "Not enough data yet" | Single point as flat line | Full sparkline + table | "Could not load history" | Grayed stale area |
| Search results | "No products found for '{query}'" | Single product row (no table header) | Paginated table | "Search unavailable" | N/A |
| Watch list | "Your watch list is empty — search and add products" | Single entry with deal status | Ordered list by priority | "Could not load watch list" | Stale indicator per entry |
| Saved searches | "No saved searches yet" | Single search with results count | List of saved searches | "Could not load searches" | N/A |
| New products | "No new products found" | Single new product card | Grid of new products | "Could not check for new products" | N/A |

### 5.2 Image fallback chain

For every product image:
1. Use the best-resolution URL from retailer data (prefer 400x400+)
2. If no image URL: render a branded placeholder with product initial + retailer color
3. If image fails to load: replace with placeholder, log network error (not user-visible)
4. MUST NOT show broken-image icon

### 5.3 Archive freshness UI

- Every offer card and deal card shows a freshness indicator:
  - Green badge: collected within freshness window (default 7 days)
  - Amber badge: collected 7-14 days ago
  - Red badge: collected >14 days ago or unknown
- The homepage shows an archive-level freshness banner: "Prices collected {X} hours ago — next collection {Y}"
- If no collection has ever run: "Awaiting first price collection — this can take a few minutes"

### 5.4 Price context display

Every price display MUST include:
- Retailer logo/badge (brand color)
- Store name
- Price context label (e.g. "Royal Oak store price", "Glenfield pickup price")
- Price kind badge: "Shelf price", "Special", "Member price"

---

## 6. Trust Baseline

### 6.1 Adapter fixture tests

Each adapter has fixture tests using captured response data from `research/*.har`:
- `test/adapters/foodstuffs.test.js` — test `toPriceObservation()` with HAR fixture data
- `test/adapters/woolworths.test.js` — test `toWoolworthsObservation()` with HAR fixture data
- `test/adapters/freshchoice.test.js` — test `toFreshChoiceObservation()` with HAR fixture
- `test/adapters/warehouse.test.js` — test `toWarehouseObservation()` with HAR fixture

Each test MUST verify:
- Correct extraction of product ID, name, price, promotion
- Handling of missing fields (undefined → null, not crash)
- Handling of unexpected HTML/JSON structure (return partial data, don't throw)

### 6.2 AbortSignal timeouts [MUST-18]

All HTTP clients in adapters MUST accept an `AbortSignal` option:
- Default timeout: 15,000ms per request
- Configurable via client options
- On timeout: throw with `name: 'TimeoutError'` (not generic Error)
- MUST NOT retry on timeout without explicit caller opt-in [MUST-18a]

### 6.3 Bounded idempotent GET retry [MUST-19]

All adapters use a shared `fetchWithRetry` helper:
- Retries only on HTTP 429, 502, 503, 504
- Maximum 3 retries
- Respects `Retry-After` header (both seconds and HTTP-date formats)
- Exponential backoff: 1s, 2s, 4s (or Retry-After, whichever is longer)
- No retry on 4xx (except 429), AbortError, or invalid URL
- MUST NOT retry non-GET requests [MUST-19a]
- MUST NOT retry if `signal.aborted` [MUST-19b]

### 6.4 Collection health / count sanity

After each daily archive run, log:
- Number of records added per retailer
- Total archive size (lines, bytes)
- Any retailers that returned 0 records (warn, not fail)
- Any retailers that failed entirely (error)
- The archive runner preserves the existing archive on failure (already implemented in `archive-daily-local.sh`)

### 6.5 All-or-nothing atomic archive

Already implemented in `scripts/archive-daily-local.sh`:
- Copy → write to temp → validate → atomic mv
- On any collector failure: preserve original, clean up temp
- MUST NOT leave partial archive in place [MUST-20a]
- MUST NOT silently skip validation [MUST-20b]

### 6.6 Stale-state API/UI [MUST-21]

- Every API response includes `_freshness: { archiveDate, latestCollection }` [MUST-21a]
- The frontend renders stale indicators based on this field, NOT client-side timers [MUST-21b]
- When no collection data exists: `archiveDate: null`, frontend shows first-collection-pending state

---

## 7. Matching Pilot

### 7.1 Automatic matching (no human review required)

- **Shared Foodstuffs source IDs:** Products from PAK'nSAVE and New World that share the same `source_id` (retailer product ID on the Foodstuffs platform) are auto-matched with `method: 'auto_source_id'` and `review_state: 'accepted'`
- **Exact GTIN:** Products from any retailer with identical non-null GTIN values are auto-matched with `method: 'auto_gtin'` and `review_state: 'accepted'`

### 7.2 Human-reviewed matching

- Product pairs matched by any other mechanism (e.g. admin tool, manual entry) are stored with `match_method: 'human_reviewed'`
- Review state is `accepted` after an explicit review action
- An admin UI (deferred; CLI script for MVP) lists pending matches for review

### 7.3 Fuzzy matching (candidate generation only) [MUST-22]

- Fuzzy matching runs as a background process (triggered manually or on rebuild)
- Results are stored with `match_method: 'fuzzy_candidate'` and `review_state: 'pending'`
- Fuzzy candidates are NEVER exposed as confirmed matches in the public API [MUST-22a]
- Fuzzy candidates MAY be shown in the UI with a "possible match — verify" label
- Fuzzy matching scope: name similarity (token overlap, Levenshtein on normalized names) within the same category

### 7.4 Matching constraints [MUST-23]

- MUST NOT present fuzzy matches as confirmed cross-retailer product comparisons [MUST-23a]
- MUST NOT auto-match products without GTIN or shared source_id [MUST-23b]
- MUST show explicit retailer/store/price context for every offer regardless of match status [MUST-23c]
- MUST label every match by method in API responses (`match_label`) [MUST-23d]
- MUST allow human override (accept/reject a fuzzy candidate) [MUST-23e]
- SHOULD NOT generate fuzzy candidates for products with different categories

---

## 8. Spec-Edge Probes: Prohibitions & Discouragements

Every MUST below has adjacent MUST NOT and/or SHOULD NOT constraints.

### 8.1 Empty state [MUST-24]
- MUST render deliberate empty-state messages [MUST-24a]
- MUST NOT crash on empty database [MUST-24b]
- MUST NOT show blank pages or spinners for empty collections [MUST-24c]
- SHOULD NOT show "no results" and "no collection" as the same message

### 8.2 Single item [MUST-25]
- MUST render single items in list containers (not as bare cards) [MUST-25a]
- MUST hide bulk-action UI when only one item exists [MUST-25b]
- MUST NOT show multi-offer comparison UI for single-offer products [MUST-25c]
- MUST NOT fabricate "other retailers" section when none exist [MUST-25d]
- SHOULD NOT paginate when results fit on one page

### 8.3 Boundary conditions [MUST-26]
- MUST reject queries > 200 characters with 400 [MUST-26a]
- MUST enforce max pagination limit of 200 [MUST-26b]
- MUST enforce min search query length of 2 characters for suggestions [MUST-26c]
- MUST truncate search input at 200 chars with visible indicator [MUST-26d]
- MUST treat whitespace-only input as empty [MUST-26e]
- MUST NOT accept unbounded input sizes anywhere [MUST-26f]
- SHOULD NOT silently truncate — return validation error or visible indicator

### 8.4 Concurrency [MUST-27]
- MUST use SQLite WAL mode for concurrent read access [MUST-27a]
- MUST wrap rebuilds in EXCLUSIVE transactions [MUST-27b]
- MUST handle SQLITE_BUSY gracefully (retry with backoff, then 503) [MUST-27c]
- MUST NOT corrupt data on concurrent writes [MUST-27d]
- MUST surface busy errors as 503, not silently drop writes [MUST-27e]
- Session token MUST be random and unpredictable [MUST-27f]
- MUST NOT have race conditions on session creation [MUST-27g]
- SHOULD NOT use in-memory locking that doesn't survive process restart

### 8.5 Failure modes [MUST-28]
- MUST retain previous good DB on rebuild failure (atomic transaction) [MUST-28a]
- MUST log parse errors with line number on JSONL import failure [MUST-28b]
- MUST NOT serve partial/corrupt data [MUST-28c]
- MUST exit process on migration failure [MUST-28d]
- MUST NOT silently skip migrations [MUST-28e]
- SHOULD NOT auto-retry import on non-transient parse failures
- MUST return 503 with Retry-After during migration [MUST-28f]

### 8.6 Permissions [MUST-29]
- MUST require authentication for watch list, saved searches, preferred store endpoints [MUST-29a]
- MUST return 401 for unauthenticated access to private endpoints [MUST-29b]
- MUST NOT expose user A's private data in user B's response [MUST-29c]
- SQLite has no row-level security — every query MUST filter by authenticated user ID [MUST-29d]
- MUST return 404 (not 403) on unauthorized access to specific resource IDs (avoid info leaks) [MUST-29e]
- MUST NOT store passwords in plaintext [MUST-29f]
- SHOULD NOT return detailed error messages on login failure ("invalid credentials" only)

### 8.7 Lifecycle [MUST-30]
- MUST apply migrations before starting HTTP listener [MUST-30a]
- MUST exit process if migration fails [MUST-30b]
- MUST NOT serve on partial/migrated schema [MUST-30c]
- MUST log each migration step with duration [MUST-30d]
- MUST handle the transition from JSONL-direct to SQLite: if SQLite absent, rebuild at startup [MUST-30e]
- MUST verify SQLite schema version matches expected version at startup [MUST-30f]
- SHOULD NOT block startup on JSONL fingerprint check if SQLite was recently rebuilt

### 8.8 Adversarial [MUST-31]
- MUST use parameter-bound SQL everywhere (no string concatenation for values) [MUST-31a]
- MUST validate product IDs against allowed pattern: `/^[a-z]+:[a-zA-Z0-9_-]+$/` [MUST-31b]
- MUST reject request bodies > 64KB with 413 [MUST-31c]
- MUST escape all user-supplied text rendered in HTML [MUST-31d]
- MUST limit session lifetime (default 24h, configurable) [MUST-31e]
- MUST NOT evaluate user input as code (no eval, no dynamic require) [MUST-31f]
- MUST NOT store unsanitized user text in DB [MUST-31g]
- SHOULD NOT accept non-ASCII input in product ID parameters

---

## 9. Security & Concurrency (Local-First Multi-User)

### 9.1 Security model
- Password hashing: Node.js `crypto.scrypt` (async) with salt (16 bytes) and cost parameters (N=16384, r=8, p=1). The async variant MUST be used on HTTP request paths — scryptSync blocks the event loop.
- Session tokens: 32-byte random via `crypto.randomBytes`, hex-encoded
- HTTP-only, SameSite=Lax, Secure (in production) cookies
- All SQL parameterized via Node.js `node:sqlite` prepared statements (zero dependencies)
- Request size limit: 64KB for POST bodies
- Rate limiting: 120 req/min/IP, 300 req/min/session tracked in app DB

### 9.2 Concurrency model
- Both SQLite DBs use WAL mode enables concurrent reads from app and CLI
- Single writer: only `scripts/build-db.js` or the app's startup rebuild writes to `data/prices.db`
- Rebuild uses `EXCLUSIVE` transaction — readers get `SQLITE_BUSY` during rebuild
- App retries read on SQLITE_BUSY up to 3 times with 100ms backoff
- The daily archive runner writes only to JSONL (single writer via mkdir lock)
- SQLite is rebuilt on next app startup, never during active collection
- `data/app.db` has its own WAL and is never contended by rebuilds

---

## 10. Phased Acceptance Criteria

### Phase 1: Foundation (SQLite projection)
- [ ] `data/prices.db` builds from `data/prices.jsonl` via `scripts/build-db.js`
- [ ] Deterministic rebuild: same JSONL → same fingerprint → no-op rebuild
- [ ] Schema migrations apply in order; failure exits process
- [ ] All projection tables created with correct constraints
- [ ] Import run recorded in `import_runs` table
- [ ] `npm test` passes including SQLite tests
- [ ] Equivalence: SQLite and JSONL repos return identical results for same queries
- [ ] **Rollback:** transaction rollback on rebuild failure leaves existing DB intact

### Phase 2: Trust & Resilience
- [ ] All adapters have HAR-backed fixture tests
- [ ] `fetchWithRetry` respects AbortSignal, Retry-After, bounded retry count
- [ ] Collection health/count logged per run
- [ ] Atomic archive behavior preserved (tested)
- [ ] Stale-state propagated through API responses
- [ ] SQLITE_BUSY handling tested with concurrent rebuild attempt

### Phase 3: App server
- [ ] HTTP server starts, applies migrations to both DBs, builds/verifies SQLite
- [ ] All public API endpoints respond correctly
- [ ] Auth: register, login, logout, session expiry
- [ ] Auth: 401 on unauthenticated private endpoints
- [ ] All empty/single/multi/error states tested
- [ ] SPA renders all 8 views with correct state handling
- [ ] Image fallback tested with missing and broken URLs

### Phase 4: Price-minder features
- [ ] Global feed prioritizes watch-list + preferred stores
- [ ] Product detail shows cross-retailer offers
- [ ] Product history with sparkline
- [ ] Saved searches: CRUD + list by user
- [ ] New products: detected and served per user
- [ ] Price context labels on every price display

### Phase 5: Matching pilot
- [ ] Auto-matching via shared Foodstuffs source IDs
- [ ] Auto-matching via exact GTIN
- [ ] Human-reviewed registry via CLI
- [ ] Fuzzy candidates stored as pending only
- [ ] API exposes match labels and review state
- [ ] No fuzzy candidates exposed as confirmed matches

---

## 11. Tests & Commands

### 11.1 Test structure
```
test/
  adapters/
    foodstuffs.test.js     # HAR fixture tests
    woolworths.test.js
    freshchoice.test.js
    warehouse.test.js
  sqlite/
    projection-repository.test.js  # rebuild, query, dedup, equivalence
    app-db.test.js                 # auth, sessions, prefs CRUD
    schema.test.js                 # migration application, version checks (both DBs)
    rebuild.test.js                # deterministic rebuild, fingerprint, malformed JSONL
    rollback.test.js               # transaction rollback, missing archive, stale archive
    concurrency.test.js            # SQLITE_BUSY, concurrent rebuild
  app/
    server.test.js         # API contract tests (all endpoints, all states)
    auth.test.js           # register, login, logout, session expiry
    permissions.test.js    # 401 on private, 404 on wrong owner
    feed.test.js           # prioritization, stale-state, empty
    matching.test.js       # auto, human, fuzzy match behavior
    adversarial.test.js    # request size, injection, XSS, product ID validation
  archive.test.js          # existing
  analytics.test.js        # existing
  local-archive-runner.test.js  # existing
```

### 11.2 Key commands
```sh
npm run build-db           # rebuild SQLite from JSONL (node scripts/build-db.js)
npm run build-db --force   # force rebuild even if fingerprint matches
npm test                   # run all tests
npm run check              # syntax check all source files
npm run archive:local      # run local daily archive (all retailers)
npm start                  # start the app server (was npm run dashboard)
```

### 11.3 Test commands for each phase
Phase 1: `npx node --test test/sqlite/`
Phase 2: `npx node --test test/adapters/ && npx node --test test/local-archive-runner.test.js`
Phase 3: `npx node --test test/app/server.test.js test/app/auth.test.js test/app/permissions.test.js`
Phase 4: `npx node --test test/app/feed.test.js && npm run check`
Phase 5: `npx node --test test/app/matching.test.js test/app/adversarial.test.js`

---

## 12. Scheduling Blocker (Environmental)

As documented in `HANDOFF.md`:
- macOS account `server` (UID 501) cannot be resolved by Directory Services
- This prevents `launchd`/`crontab`/`sudo` — the scheduling path is blocked
- MUST NOT bypass this by running collection in-process, on a timer, or via GitHub Actions
- MUST NOT attempt sudo, launchctl bootstrap, or crontab operations until the account is fixed
- The collector runs manually via `npm run archive:local` until scheduling is resolved

---

## 13. Implementation Sequence for Subsequent Workers

### Worker 1: SQLite Projection Foundation
1. Create `src/sqlite/projection-repository.js` using `node:sqlite` — read-only rebuildable projection (no append/dual-write)
2. Create `src/sqlite/schema.js` with projection table definitions and migration runner
3. Create `src/sqlite/migrations/projection/001_initial.sql`
4. Create `scripts/build-db.js` — CLI that rebuilds projection DB from JSONL
5. Write tests: `test/sqlite/projection-repository.test.js`, `test/sqlite/schema.test.js`, `test/sqlite/rebuild.test.js`

### Worker 2: Application DB & Auth
1. Create `src/sqlite/app-db.js` using `node:sqlite` — manages auth, sessions, prefs, watch, searches
2. Create `src/sqlite/migrations/app/001_app_auth.sql`
3. Create `src/app/auth.js` — register, login, logout, session management (async `crypto.scrypt`)
4. Write tests: `test/sqlite/app-db.test.js`, `test/app/auth.test.js`

### Worker 3: Trust & Adapter Resilience
1. Create `src/adapters/fetch-with-retry.js` — shared `fetchWithRetry` helper with AbortSignal, Retry-After, bounded retry
2. Update all 5 adapters to use the shared helper
3. Add HAR fixture tests for all retailers
4. Verify atomic archive behavior preserved
5. Add collection health/count sanity logging

### Worker 4: App Server Core
1. Create `src/app/server.js` — HTTP server with startup sequence (both DB migrations → SQLite build → listener)
2. Implement all public API endpoints in `src/app/api/public.js`
3. Implement all authenticated API endpoints in `src/app/api/private.js`
4. Adapt Workbench SPA into `public/` — change API paths from Workbench to direct server
5. Write API contract tests: `test/app/server.test.js`, `test/app/feed.test.js`, `test/app/permissions.test.js`, `test/app/adversarial.test.js`

### Worker 5: Price-minder Features
1. Feed prioritization (watch-list + preferred stores) in `src/app/api/public.js`
2. Saved searches CRUD + new-products detection in `src/app/api/private.js`
3. All empty/single/multi/error/stale UI states in SPA
4. Image fallback with branded placeholders
5. Product comparison/detail view enhancements
6. Archive freshness indicators in UI
7. Write feature tests

### Worker 6: Matching Pilot
1. Auto-matching on shared Foodstuffs source IDs in `src/sqlite/matching.js`
2. Auto-matching on exact GTIN
3. Human-reviewed registry CLI (`scripts/matching-cli.js`)
4. Fuzzy matching candidate generation (name similarity, same category)
5. Match label exposure in API
6. Matching tests: `test/app/matching.test.js`

### Worker 7: Deprecation, Documentation & Integration
1. Deprecate old `dashboard/`: replace `server.js` entry point with a deprecation pointer. Do NOT delete any files.
2. Add pointer README.md to `.worktrees/sqlite-migration/` noting its work has been absorbed into main; do NOT delete the worktree.
3. Add pointer README.md to `workbench/projects/grocery-prices/` noting the app has moved to `prices` repo; do NOT delete or archive.
4. Full system integration test (`npm test && npm run check && npm run pack:check`)
5. Benchmark: rebuild time, query latency
6. Documentation pass: update README, HANDOFF, CONTEXT

---

## 14. MUST-ID Traceability Matrix

| MUST ID | Requirement | MUST NOT / SHOULD NOT | Source |
|---------|-------------|----------------------|--------|
| MUST-01 | `/api/deals` returns shaped feed | MUST-01c: NOT show insufficient-history signals; MUST-01d: NOT fabricate baselines | §4.1 |
| MUST-01a | Empty array when no deals match | MUST NOT return 404/error | §4.1 |
| MUST-01b | Include archiveFreshness in response | MUST NOT omit freshness data | §4.1 |
| MUST-01c | NOT show signals with < minSamples | SHOULD NOT display empty signal badges | §4.1 |
| MUST-01d | NOT fabricate baseline data | MUST NOT extrapolate from single observation | §4.1 |
| MUST-02 | `/api/products` search | MUST-02b: reject >200 chars; MUST-02c: validate all params | §4.1 |
| MUST-02a | Empty products array on no match | MUST NOT return 404 | §4.1 |
| MUST-02b | Reject queries >200 chars | MUST NOT silently truncate | §4.1, §8.3 |
| MUST-02c | Validate all query params | MUST return 400 on constraint violation | §4.1 |
| MUST-03 | `/api/products/:id` detail | MUST-03a/b/c: handle single/no/multi offer | §4.1 |
| MUST-03a | Single-offer: no comparison UI | MUST NOT show multi-offer table | §4.1, §8.2 |
| MUST-03b | No-offer: metadata + empty offers + message | MUST NOT fabricate offers | §4.1 |
| MUST-03c | Multi-offer: comparison table | MUST NOT hide legitimate offers | §4.1 |
| MUST-04 | `/api/products/:id/history` | MUST-04a: 404 on missing; MUST-04b: empty on no-offer | §4.1 |
| MUST-04a | 404 if product not found | MUST NOT return 200 with empty | §4.1 |
| MUST-04b | Empty history if no offers | MUST NOT return 404 | §4.1 |
| MUST-05 | `/api/stores` | — | §4.1 |
| MUST-06 | `/api/search/suggestions` | Min 2 chars (§8.3), max 100 chars | §4.1 |
| MUST-07 | `/api/health` | — | §4.1 |
| MUST-08 | `GET /api/watch-list` | MUST-08a: 401 if not auth; MUST-08b: empty array | §4.2 |
| MUST-08a | 401 on unauthenticated | MUST NOT return partial data | §4.2, §8.6 |
| MUST-08b | Empty array when empty | MUST NOT return 404/error | §4.2 |
| MUST-09 | `POST /api/watch-list` | MUST-09a: 400 on bad targetKind; MUST-09b: 400 on empty targetId | §4.2 |
| MUST-10 | `DELETE /api/watch-list/:id` | MUST-10a: 404 if not owned; MUST-10b: NOT delete others' entries | §4.2 |
| MUST-11 | `GET /api/preferred-stores` | — | §4.2 |
| MUST-12 | `POST /api/preferred-stores` | MUST-12a: validate contextId; MUST-12b: rank 0 = remove | §4.2 |
| MUST-13 | `DELETE /api/preferred-stores/:id` | — | §4.2 |
| MUST-14 | `GET /api/saved-searches` | — | §4.2 |
| MUST-15 | `POST /api/saved-searches` | MUST-15a: dedup; MUST-15b: reject empty name/query; MUST-15c: reject >100 chars | §4.2 |
| MUST-16 | `DELETE /api/saved-searches/:id` | MUST-16a: 404 if not owned | §4.2 |
| MUST-17 | `GET /api/new-products` | — | §4.2 |
| MUST-18 | AbortSignal timeouts | MUST-18a: NOT retry on timeout without opt-in | §6.2 |
| MUST-19 | fetchWithRetry helper | MUST-19a: NOT retry non-GET; MUST-19b: NOT retry aborted | §6.3 |
| MUST-20 | Atomic archive | MUST-20a: NOT leave partial archive; MUST-20b: NOT skip validation | §6.5 |
| MUST-21 | Stale-state API/UI | MUST-21a: _freshness in every response; MUST-21b: UI uses server field, not client timer | §6.6 |
| MUST-22 | Fuzzy matching | MUST-22a: NEVER exposed as confirmed | §7.3 |
| MUST-23 | Matching constraints | MUST-23a: NOT present fuzzy as confirmed; MUST-23b: NOT auto-match without GTIN/source_id; MUST-23c: context on every offer; MUST-23d: label every match; MUST-23e: allow human override | §7.4 |
| MUST-24 | Empty states | MUST-24a: render deliberate messages; MUST-24b: NOT crash; MUST-24c: NOT show blank pages | §8.1 |
| MUST-25 | Single-item states | MUST-25a: list containers; MUST-25b: hide bulk UI; MUST-25c: NOT multi-offer UI; MUST-25d: NOT fabricate retailers | §8.2 |
| MUST-26 | Boundary conditions | MUST-26a: >200 chars → 400; MUST-26b: max pagination 200; MUST-26c: min 2 chars suggestions; MUST-26d: truncate with indicator; MUST-26e: whitespace = empty; MUST-26f: NOT accept unbounded input | §8.3 |
| MUST-27 | Concurrency | MUST-27a: WAL mode; MUST-27b: EXCLUSIVE on rebuild; MUST-27c: SQLITE_BUSY → retry then 503; MUST-27d: NOT corrupt data; MUST-27e: NOT silently drop; MUST-27f: random session token; MUST-27g: NOT race on session create | §8.4 |
| MUST-28 | Failure modes | MUST-28a: retain good DB on rebuild failure; MUST-28b: log parse errors with line number; MUST-28c: NOT serve partial data; MUST-28d: exit on migration failure; MUST-28e: NOT skip migrations; MUST-28f: 503 with Retry-After during migration | §8.5 |
| MUST-29 | Permissions | MUST-29a: auth required for private endpoints; MUST-29b: 401 on unauthenticated; MUST-29c: NOT expose cross-user data; MUST-29d: filter by user ID; MUST-29e: 404 not 403 on unauthorized resource; MUST-29f: NOT plaintext passwords | §8.6 |
| MUST-30 | Lifecycle | MUST-30a: migrations before listener; MUST-30b: exit on failure; MUST-30c: NOT serve partial; MUST-30d: log migration duration; MUST-30e: rebuild if SQLite absent; MUST-30f: verify schema version | §8.7 |
| MUST-31 | Adversarial | MUST-31a: parameter-bound SQL; MUST-31b: validate product-ID pattern; MUST-31c: reject >64KB bodies; MUST-31d: escape HTML; MUST-31e: limit session lifetime; MUST-31f: NOT eval/dynamic require; MUST-31g: NOT store unsanitized text | §8.8 |

---

## 15. Completion Definition

The full programme is **complete** when:

1. **All 31 MUST constraints pass** their automated tests with no failures.
2. **`npm test` exits 0** on a clean checkout with no pre-existing `data/prices.db` or `data/app.db`.
3. **`node scripts/build-db.js`** produces a `data/prices.db` that passes equivalence tests against `JsonlObservationRepository` over the live `data/prices.jsonl` archive.
4. **`npm start`** launches the HTTP server, applies both DB schemas, rebuilds the projection if stale, and serves the SPA.
5. **Dashboard deprecation:** The old `dashboard/` server has a deprecation pointer; the directory and files are untouched.
6. **Workbench reference:** The prototype at `workbench/projects/grocery-prices` is unmodified; a pointer README has been added.
7. **Worktree reference:** The `.worktrees/sqlite-migration` worktree is untouched; a pointer README has been added.
8. **Rebuild never touches `data/app.db`:** Verified by a test that deletes `data/prices.db`, rebuilds, and asserts `data/app.db` tables are intact.
9. **Rollback/recovery verified:** Tests prove rebuild failure leaves existing DB intact; malformed JSONL is skipped with logged warning; missing JSONL triggers degraded mode.
10. **Two-DB schema migrations** both apply cleanly in order; failure of either exits the process.
