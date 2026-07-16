import { DatabaseSync } from 'node:sqlite';
import { applyAppMigrations, ensureMigrationTable } from './schema.js';

export class AppDatabase {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
    this.db.exec('PRAGMA busy_timeout=5000');
    ensureMigrationTable(this.db);
    applyAppMigrations(this.db);
  }

  getUserById(id) {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) || null;
  }

  getUserByUsername(username) {
    return this.db.prepare(
      'SELECT * FROM users WHERE LOWER(username) = LOWER(?)'
    ).get(username) || null;
  }

  createUser(username, passwordHash) {
    const result = this.db.prepare(
      'INSERT INTO users (username, password_hash) VALUES (?, ?)'
    ).run(username, passwordHash);
    return this.getUserById(Number(result.lastInsertRowid));
  }

  getSession(tokenHash) {
    return this.db.prepare(`
      SELECT s.id, s.user_id, s.expires_at, s.created_at, u.username
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.id = ?
    `).get(tokenHash) || null;
  }

  createSession(userId, tokenHash, expiresAt) {
    this.db.prepare(
      'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
    ).run(tokenHash, userId, expiresAt);
  }

  deleteSession(tokenHash) {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(tokenHash);
  }

  cleanExpiredSessions(now) {
    const result = this.db.prepare(
      'DELETE FROM sessions WHERE expires_at <= ?'
    ).run(now);
    return result.changes;
  }

  getStorePreferences(userId) {
    return this.db.prepare(
      'SELECT * FROM user_store_preferences WHERE user_id = ? ORDER BY rank ASC'
    ).all(userId);
  }

  setStorePreference(userId, contextId, rank) {
    this.db.prepare(`
      INSERT INTO user_store_preferences (user_id, context_id, rank)
      VALUES (?, ?, ?)
      ON CONFLICT(user_id, context_id) DO UPDATE SET rank = ?
    `).run(userId, contextId, rank, rank);
  }

  deleteStorePreference(userId, contextId) {
    this.db.prepare(
      'DELETE FROM user_store_preferences WHERE user_id = ? AND context_id = ?'
    ).run(userId, contextId);
  }

  getWatchList(userId) {
    return this.db.prepare(
      'SELECT * FROM watch_list_entries WHERE user_id = ? ORDER BY created_at DESC'
    ).all(userId);
  }

  getWatchListEntry(entryId) {
    return this.db.prepare(
      'SELECT * FROM watch_list_entries WHERE id = ?'
    ).get(entryId) || null;
  }

  addWatchListEntry(userId, targetKind, targetId, label) {
    const result = this.db.prepare(`
      INSERT INTO watch_list_entries (user_id, target_kind, target_id, label)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, target_kind, target_id) DO NOTHING
    `).run(userId, targetKind, targetId, label);
    return Number(result.lastInsertRowid);
  }

  deleteWatchListEntry(entryId) {
    this.db.prepare(
      'DELETE FROM watch_list_entries WHERE id = ?'
    ).run(entryId);
  }

  getSavedSearches(userId) {
    return this.db.prepare(
      'SELECT * FROM saved_searches WHERE user_id = ? ORDER BY created_at DESC'
    ).all(userId);
  }

  getSavedSearch(searchId) {
    return this.db.prepare(
      'SELECT * FROM saved_searches WHERE id = ?'
    ).get(searchId) || null;
  }

  createSavedSearch(userId, name, queryText, retailerFilter, categoryFilter, normalizedHash) {
    const result = this.db.prepare(`
      INSERT INTO saved_searches (user_id, name, query_text, retailer_filter, category_filter, normalized_hash)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, normalized_hash) DO NOTHING
    `).run(userId, name, queryText, retailerFilter ?? null, categoryFilter ?? null, normalizedHash);
    if (result.changes === 0) return null;
    return this.getSavedSearch(Number(result.lastInsertRowid));
  }

  deleteSavedSearch(searchId) {
    this.db.prepare(
      'DELETE FROM saved_searches WHERE id = ?'
    ).run(searchId);
  }

  getNewProductNotices() {
    return this.db.prepare(
      'SELECT * FROM new_product_notices WHERE notified = 0 ORDER BY first_seen_at DESC'
    ).all();
  }

  markAllNotified() {
    this.db.prepare(
      'UPDATE new_product_notices SET notified = 1 WHERE notified = 0'
    ).run();
  }

  // ---- Product Matching ----

  getMatchPairs(options = {}) {
    const { methods, states } = options;
    let sql = 'SELECT * FROM product_match_pairs WHERE 1=1';
    const params = [];
    if (methods && methods.length > 0) {
      sql += ` AND match_method IN (${methods.map(() => '?').join(',')})`;
      params.push(...methods);
    }
    if (states && states.length > 0) {
      sql += ` AND review_state IN (${states.map(() => '?').join(',')})`;
      params.push(...states);
    }
    sql += ' ORDER BY created_at DESC';
    return this.db.prepare(sql).all(...params);
  }

  getMatchPair(productAId, productBId) {
    const aId = String(productAId);
    const bId = String(productBId);
    const [pa, pb] = aId < bId ? [aId, bId] : [bId, aId];
    return this.db.prepare(
      'SELECT * FROM product_match_pairs WHERE product_a_id = ? AND product_b_id = ?'
    ).get(pa, pb) || null;
  }

  getMatchPairById(id) {
    return this.db.prepare(
      'SELECT * FROM product_match_pairs WHERE id = ?'
    ).get(id) || null;
  }

  getMatchesForProduct(productId) {
    return this.db.prepare(`
      SELECT * FROM product_match_pairs
      WHERE product_a_id = ? OR product_b_id = ?
      ORDER BY confidence DESC
    `).all(productId, productId);
  }

  createMatchPair({ productAId, productBId, matchMethod, algorithmVersion, confidence, reviewState, provenance, inputEvidenceHash }) {
    const [pa, pb] = productAId < productBId ? [productAId, productBId] : [productBId, productAId];
    const result = this.db.prepare(`
      INSERT INTO product_match_pairs
        (product_a_id, product_b_id, match_method, algorithm_version, confidence, review_state, provenance, input_evidence_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(pa, pb, matchMethod, algorithmVersion, confidence, reviewState, provenance, inputEvidenceHash ?? null);
    return Number(result.lastInsertRowid);
  }

  updateMatchPair(id, { matchMethod, confidence, reviewState, provenance, inputEvidenceHash }) {
    this.db.prepare(`
      UPDATE product_match_pairs
      SET match_method = ?, confidence = ?, review_state = ?,
          provenance = ?, input_evidence_hash = ?
      WHERE id = ?
    `).run(matchMethod, confidence, reviewState, provenance, inputEvidenceHash ?? null, id);
  }

  updateMatchReview(id, reviewState, reviewer) {
    this.db.prepare(`
      UPDATE product_match_pairs
      SET review_state = ?, provenance = 'user', reviewer = ?,
          reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE id = ?
    `).run(reviewState, reviewer, id);
  }

  deleteMatchPair(id) {
    this.db.prepare('DELETE FROM product_match_pairs WHERE id = ?').run(id);
  }

  checkAndIncrementRateLimit(bucketKey, maxCount, windowMs, now) {
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const row = this.db.prepare(
      'SELECT count FROM rate_limit WHERE bucket_key = ? AND window_start = ?'
    ).get(bucketKey, windowStart);
    const currentCount = row ? row.count : 0;
    if (currentCount >= maxCount) {
      return false;
    }
    if (row) {
      this.db.prepare(
        'UPDATE rate_limit SET count = count + 1 WHERE bucket_key = ? AND window_start = ?'
      ).run(bucketKey, windowStart);
    } else {
      this.db.prepare(
        'INSERT INTO rate_limit (bucket_key, window_start, count) VALUES (?, ?, 1)'
      ).run(bucketKey, windowStart);
    }
    this._cleanOldRateLimitBuckets(now, windowMs);
    return true;
  }

  _cleanOldRateLimitBuckets(now, windowMs) {
    this.db.prepare(
      'DELETE FROM rate_limit WHERE window_start < ?'
    ).run(now - windowMs * 2);
  }

  close() {
    this.db.close();
  }
}
