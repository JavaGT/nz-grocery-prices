-- Flat read model for serving the live site directly from archive.db.
--
-- One row per product×retailer holding the latest representative offer, with the
-- fields the site filters/sorts/searches on promoted to real, indexed columns
-- (name/brand/category/image + current & regular price + store). This lets
-- /products, /stores and /stats answer with indexed SQL over ~8.5k rows instead
-- of materialising every offer revision (~500k JSON+clone rows) per request.
--
-- Derived, not authoritative: maintained incrementally on append() and fully
-- rebuildable from the offer/product/store tables (see rebuildListings()).

CREATE TABLE IF NOT EXISTS product_listings (
  product_id    TEXT NOT NULL,
  retailer      TEXT NOT NULL,
  name          TEXT,
  brand         TEXT,
  image_url     TEXT,
  category      TEXT,
  gtin          TEXT,
  store_id      TEXT,
  store_name    TEXT,
  current_cents INTEGER,
  regular_cents INTEGER,
  last_seen     INTEGER NOT NULL,
  search_text   TEXT,
  PRIMARY KEY (product_id, retailer)
);

CREATE INDEX IF NOT EXISTS idx_pl_retailer_seen ON product_listings(retailer, last_seen DESC);
CREATE INDEX IF NOT EXISTS idx_pl_seen ON product_listings(last_seen DESC);
