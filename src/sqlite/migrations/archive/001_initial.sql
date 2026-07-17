-- Authoritative archive DB (data/archive.db).
-- Immutable collection history. Never open app.db from this path.
-- prices.db remains a separate rebuildable website projection.

CREATE TABLE IF NOT EXISTS schema_migrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  sql_hash    TEXT NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS collection_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL CHECK(status IN ('running','completed','failed')),
  retailer      TEXT,
  note          TEXT,
  products_added INTEGER NOT NULL DEFAULT 0,
  stores_added   INTEGER NOT NULL DEFAULT 0,
  offers_added   INTEGER NOT NULL DEFAULT 0,
  snapshots_added INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS retailers (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS price_contexts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  retailer_id TEXT NOT NULL REFERENCES retailers(id),
  store_id    TEXT NOT NULL,
  store_name  TEXT,
  address     TEXT,
  region      TEXT,
  UNIQUE(retailer_id, store_id)
);

CREATE TABLE IF NOT EXISTS product_revisions (
  hash         TEXT PRIMARY KEY,
  product_id   TEXT NOT NULL,
  retailer_id  TEXT NOT NULL,
  data         TEXT NOT NULL,
  observed_at  INTEGER NOT NULL,
  seq          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_arch_pr_product
  ON product_revisions(product_id, observed_at DESC, seq DESC);

CREATE TABLE IF NOT EXISTS store_revisions (
  hash         TEXT PRIMARY KEY,
  context_id   INTEGER NOT NULL REFERENCES price_contexts(id),
  data         TEXT NOT NULL,
  observed_at  INTEGER NOT NULL,
  seq          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_arch_sr_context
  ON store_revisions(context_id, observed_at DESC, seq DESC);

CREATE TABLE IF NOT EXISTS offer_identities (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  offer_key   TEXT NOT NULL UNIQUE,
  product_id  TEXT NOT NULL,
  context_id  INTEGER NOT NULL REFERENCES price_contexts(id),
  UNIQUE(product_id, context_id)
);

CREATE TABLE IF NOT EXISTS offer_revisions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_id         INTEGER NOT NULL REFERENCES offer_identities(id),
  rev_hash            TEXT NOT NULL,
  price_regular_cents INTEGER NOT NULL CHECK(price_regular_cents >= 0),
  price_promo_cents   INTEGER CHECK(price_promo_cents IS NULL OR price_promo_cents >= 0),
  price_member_cents  INTEGER CHECK(price_member_cents IS NULL OR price_member_cents >= 0),
  comparative         TEXT,
  promotion_data      TEXT,
  source_data         TEXT NOT NULL,
  observed_at         INTEGER NOT NULL,
  seq                 INTEGER NOT NULL,
  UNIQUE(identity_id, rev_hash, observed_at)
);

CREATE INDEX IF NOT EXISTS idx_arch_or_identity
  ON offer_revisions(identity_id, observed_at DESC, seq DESC);
CREATE INDEX IF NOT EXISTS idx_arch_or_product
  ON offer_revisions(identity_id, observed_at DESC);

CREATE TABLE IF NOT EXISTS listing_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  context_id   INTEGER NOT NULL REFERENCES price_contexts(id),
  scope        TEXT NOT NULL DEFAULT 'specials',
  observed_at  INTEGER NOT NULL,
  offers_hash  TEXT NOT NULL,
  offer_count  INTEGER NOT NULL,
  seq          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_arch_ls_context
  ON listing_snapshots(context_id, scope, observed_at DESC, seq DESC);

CREATE TABLE IF NOT EXISTS listing_snapshot_changes (
  snapshot_id  INTEGER NOT NULL REFERENCES listing_snapshots(id),
  identity_id  INTEGER NOT NULL REFERENCES offer_identities(id),
  change       TEXT NOT NULL CHECK(change IN ('added','removed')),
  PRIMARY KEY (snapshot_id, identity_id, change)
);

CREATE INDEX IF NOT EXISTS idx_arch_lsc_identity
  ON listing_snapshot_changes(identity_id, snapshot_id);

-- Rebuildable current-state caches (not authoritative alone).
CREATE TABLE IF NOT EXISTS latest_product_revisions (
  product_id   TEXT PRIMARY KEY,
  hash         TEXT NOT NULL,
  observed_at  INTEGER NOT NULL,
  seq          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS latest_store_revisions (
  context_id   INTEGER PRIMARY KEY REFERENCES price_contexts(id),
  hash         TEXT NOT NULL,
  observed_at  INTEGER NOT NULL,
  seq          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS latest_offer_revisions (
  identity_id  INTEGER PRIMARY KEY REFERENCES offer_identities(id),
  rev_hash     TEXT NOT NULL,
  revision_id  INTEGER NOT NULL REFERENCES offer_revisions(id),
  observed_at  INTEGER NOT NULL,
  seq          INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS active_special_offers (
  context_id   INTEGER NOT NULL REFERENCES price_contexts(id),
  scope        TEXT NOT NULL DEFAULT 'specials',
  identity_id  INTEGER NOT NULL REFERENCES offer_identities(id),
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (context_id, scope, identity_id)
);

CREATE TABLE IF NOT EXISTS _meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS archive_seq (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  next_seq INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO archive_seq(id, next_seq) VALUES (1, 1);
