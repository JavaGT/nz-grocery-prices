CREATE TABLE IF NOT EXISTS deals (
  product_id        TEXT NOT NULL,
  store_id          TEXT NOT NULL,
  retailer          TEXT NOT NULL,
  current_cents     INTEGER NOT NULL CHECK(current_cents >= 0),
  price_kind        TEXT,
  drop_percent      REAL,
  is_all_time_low   INTEGER NOT NULL DEFAULT 0 CHECK(is_all_time_low IN (0, 1)),
  baseline_avg_cents INTEGER CHECK(baseline_avg_cents IS NULL OR baseline_avg_cents >= 0),
  baseline_samples   INTEGER CHECK(baseline_samples IS NULL OR baseline_samples >= 0),
  observed_at       INTEGER NOT NULL,
  promotion_data    TEXT,
  computed_at       INTEGER NOT NULL,
  PRIMARY KEY (product_id, store_id)
);

CREATE INDEX IF NOT EXISTS idx_deals_drop_percent ON deals(drop_percent DESC);
