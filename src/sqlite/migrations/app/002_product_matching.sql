CREATE TABLE IF NOT EXISTS product_match_pairs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  product_a_id       TEXT NOT NULL,
  product_b_id       TEXT NOT NULL,
  match_method       TEXT NOT NULL CHECK(match_method IN ('auto_gtin','auto_source_id','fuzzy_candidate','human_reviewed')),
  algorithm_version  TEXT NOT NULL,
  confidence         REAL CHECK(confidence >= 0 AND confidence <= 1),
  review_state       TEXT NOT NULL DEFAULT 'candidate' CHECK(review_state IN ('candidate','confirmed','rejected')),
  provenance         TEXT NOT NULL DEFAULT 'system' CHECK(provenance IN ('system','user')),
  reviewer           TEXT,
  reviewed_at        TEXT,
  input_evidence_hash TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(product_a_id, product_b_id)
);

CREATE INDEX IF NOT EXISTS idx_pmp_product_a ON product_match_pairs(product_a_id);
CREATE INDEX IF NOT EXISTS idx_pmp_product_b ON product_match_pairs(product_b_id);
CREATE INDEX IF NOT EXISTS idx_pmp_state ON product_match_pairs(review_state);
CREATE INDEX IF NOT EXISTS idx_pmp_method ON product_match_pairs(match_method);
