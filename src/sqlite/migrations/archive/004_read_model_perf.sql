-- Read-model performance: turn the site's cold read paths from full scans of
-- the ~1M-row authoritative tables into bounded, indexed reads.
--
-- 1. idx_or_observed: summary()'s MIN/MAX(observed_at) and any observed_at range
--    scan were resolved by a full covering-index scan of every offer_revision
--    (~1s cold). A dedicated observed_at index makes MIN/MAX an index-endpoint
--    lookup and range filters a seek.
--
-- 2. specials: a materialized top-N advertised-specials feed. The live query
--    starts from active_special_offers (~1M rows) and sorts ~800k computed
--    discount ratios in a temp b-tree on every cold /api/deals request (~7.5s).
--    Rebuilt per collection into this small table, read as an indexed top-N.
--    Derived, not authoritative; fully rebuildable (see rebuildSpecials()).

CREATE INDEX IF NOT EXISTS idx_or_observed ON offer_revisions(observed_at);

CREATE TABLE IF NOT EXISTS specials (
  product_id     TEXT NOT NULL,
  store_id       TEXT NOT NULL,
  retailer       TEXT NOT NULL,
  current_cents  INTEGER NOT NULL CHECK(current_cents >= 0),
  regular_cents  INTEGER NOT NULL CHECK(regular_cents >= 0),
  save_percent   REAL,
  promotion_data TEXT,
  observed_at    INTEGER NOT NULL,
  computed_at    INTEGER NOT NULL,
  PRIMARY KEY (product_id, store_id)
);

CREATE INDEX IF NOT EXISTS idx_specials_save ON specials(save_percent DESC);
