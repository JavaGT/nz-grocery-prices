-- Projection DB: initial schema
-- Derived from docs/implementation-spec.md §3.2

CREATE TABLE IF NOT EXISTS schema_migrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  sql_hash    TEXT NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS import_runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  jsonl_path       TEXT NOT NULL,
  jsonl_hash       TEXT NOT NULL,
  jsonl_size       INTEGER NOT NULL DEFAULT 0,
  records_imported INTEGER NOT NULL DEFAULT 0,
  errors           INTEGER NOT NULL DEFAULT 0,
  error_detail     TEXT,
  started_at       TEXT NOT NULL,
  finished_at      TEXT,
  status           TEXT NOT NULL CHECK(status IN ('running','completed','failed'))
);

CREATE TABLE IF NOT EXISTS retailers (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  website     TEXT
);

CREATE TABLE IF NOT EXISTS price_contexts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  retailer_id   TEXT NOT NULL REFERENCES retailers(id),
  store_id      TEXT NOT NULL,
  store_name    TEXT NOT NULL,
  scope_kind    TEXT NOT NULL CHECK(scope_kind IN ('physical-store','fulfilment-store','store-site','national-online')),
  address       TEXT,
  region        TEXT,
  UNIQUE(retailer_id, store_id)
);

CREATE TABLE IF NOT EXISTS products (
  id              TEXT NOT NULL,
  retailer_id     TEXT NOT NULL REFERENCES retailers(id),
  name            TEXT NOT NULL,
  brand           TEXT,
  category        TEXT,
  image_url       TEXT,
  size            TEXT,
  source_id       TEXT,
  gtin            TEXT,
  latest_hash     TEXT NOT NULL,
  first_seen_at   INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (id, retailer_id)
);

CREATE INDEX IF NOT EXISTS idx_products_name ON products(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_products_source ON products(source_id);
CREATE INDEX IF NOT EXISTS idx_products_gtin ON products(gtin);

CREATE TABLE IF NOT EXISTS product_revisions (
  hash          TEXT PRIMARY KEY,
  product_id    TEXT NOT NULL,
  retailer_id   TEXT NOT NULL,
  data          TEXT NOT NULL,
  observed_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pr_product ON product_revisions(product_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS store_revisions (
  hash          TEXT PRIMARY KEY,
  context_id    INTEGER NOT NULL REFERENCES price_contexts(id),
  data          TEXT NOT NULL,
  observed_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sr_context ON store_revisions(context_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS offer_revisions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_key           TEXT NOT NULL,
  product_id          TEXT NOT NULL,
  context_id          INTEGER NOT NULL REFERENCES price_contexts(id),
  product_rev_hash    TEXT REFERENCES product_revisions(hash),
  store_rev_hash      TEXT REFERENCES store_revisions(hash),
  rev_hash            TEXT NOT NULL,
  price_regular_cents INTEGER NOT NULL CHECK(price_regular_cents >= 0),
  price_promo_cents   INTEGER CHECK(price_promo_cents IS NULL OR price_promo_cents >= 0),
  price_member_cents  INTEGER CHECK(price_member_cents IS NULL OR price_member_cents >= 0),
  comparative         TEXT,
  promotion_data      TEXT,
  source_data         TEXT NOT NULL,
  observed_at         INTEGER NOT NULL,
  -- (offer_key, observed_at) prefix doubles as the offer lookup/order index,
  -- so no separate idx_or_offer_key is needed.
  UNIQUE(offer_key, observed_at, rev_hash)
);

CREATE INDEX IF NOT EXISTS idx_or_product ON offer_revisions(product_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_or_context ON offer_revisions(context_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS special_snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  context_id    INTEGER NOT NULL REFERENCES price_contexts(id),
  observed_at   INTEGER NOT NULL,
  offers_hash   TEXT NOT NULL,
  offer_count   INTEGER NOT NULL,
  added         TEXT NOT NULL,
  removed       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ss_time ON special_snapshots(context_id, observed_at DESC);

CREATE VIEW IF NOT EXISTS price_observations AS
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
  AND json_valid(ss.added)
  AND EXISTS (SELECT 1 FROM json_each(ss.added) WHERE value = or2.offer_key);

-- product_matches and deal_signals tables were removed: documented dead
-- artifacts (AGENTS.md / DECISIONLOG). Matching truth lives in app.db
-- product_match_pairs; deals are computed at runtime by src/analytics.js.

CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
