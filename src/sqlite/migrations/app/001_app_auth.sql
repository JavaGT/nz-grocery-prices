CREATE TABLE IF NOT EXISTS schema_migrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  sql_hash    TEXT NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_norm
  ON users(LOWER(username));

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  expires_at    INTEGER NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS user_store_preferences (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  context_id    INTEGER NOT NULL,
  rank          INTEGER NOT NULL CHECK(rank >= 0),
  UNIQUE(user_id, context_id)
);
CREATE INDEX IF NOT EXISTS idx_usp_user ON user_store_preferences(user_id, rank);

CREATE TABLE IF NOT EXISTS saved_searches (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  name            TEXT NOT NULL,
  query_text      TEXT NOT NULL,
  retailer_filter TEXT,
  category_filter TEXT,
  normalized_hash TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(user_id, normalized_hash)
);
CREATE INDEX IF NOT EXISTS idx_ss_user ON saved_searches(user_id);

CREATE TABLE IF NOT EXISTS watch_list_entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  target_kind   TEXT NOT NULL CHECK(target_kind IN ('product','category','saved_search')),
  target_id     TEXT NOT NULL,
  label         TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE(user_id, target_kind, target_id)
);
CREATE INDEX IF NOT EXISTS idx_wle_user ON watch_list_entries(user_id);

CREATE TABLE IF NOT EXISTS new_product_notices (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id    TEXT NOT NULL,
  retailer_id   TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  notified      INTEGER NOT NULL DEFAULT 0,
  UNIQUE(product_id, retailer_id)
);

CREATE TABLE IF NOT EXISTS rate_limit (
  bucket_key    TEXT NOT NULL,
  window_start  INTEGER NOT NULL,
  count         INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (bucket_key, window_start)
);
