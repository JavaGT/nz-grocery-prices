import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppDatabase } from '../../src/sqlite/app-db.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'appdb-test-'));
  const dbPath = join(dir, 'test.db');
  const db = new AppDatabase(dbPath);
  return { dir, db, dbPath };
}

describe('AppDatabase', () => {
  it('constructor applies migrations and creates tables', () => {
    const { db, dir } = setup();
    try {
      const tables = db.db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      ).all().map(r => r.name);
      assert.ok(tables.includes('users'));
      assert.ok(tables.includes('sessions'));
      assert.ok(tables.includes('user_store_preferences'));
      assert.ok(tables.includes('saved_searches'));
      assert.ok(tables.includes('watch_list_entries'));
      assert.ok(tables.includes('new_product_notices'));
      assert.ok(tables.includes('rate_limit'));
      assert.ok(tables.includes('product_match_pairs'));
      assert.ok(tables.includes('schema_migrations'));
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('createUser stores and returns user with correct fields', () => {
    const { db, dir } = setup();
    try {
      const user = db.createUser('Alice', 'hash:abc123');
      assert.ok(user);
      assert.equal(user.username, 'Alice');
      assert.equal(user.password_hash, 'hash:abc123');
      assert.ok(user.id);
      assert.ok(user.created_at);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getUserByUsername finds by exact username', () => {
    const { db, dir } = setup();
    try {
      db.createUser('Bob', 'hash:xyz');
      const found = db.getUserByUsername('Bob');
      assert.ok(found);
      assert.equal(found.username, 'Bob');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getUserByUsername finds by different case (case-insensitive)', () => {
    const { db, dir } = setup();
    try {
      db.createUser('Charlie', 'hash:def');
      const found = db.getUserByUsername('charlie');
      assert.ok(found);
      assert.equal(found.username, 'Charlie');
      const found2 = db.getUserByUsername('CHARLIE');
      assert.ok(found2);
      assert.equal(found2.username, 'Charlie');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getUserByUsername returns null for nonexistent user', () => {
    const { db, dir } = setup();
    try {
      const found = db.getUserByUsername('nobody');
      assert.equal(found, null);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('createUser rejects duplicate normalized username', () => {
    const { db, dir } = setup();
    try {
      db.createUser('Diana', 'hash:aaa');
      assert.throws(() => db.createUser('diana', 'hash:bbb'), /UNIQUE/i);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('createSession stores token hash and createsSession adds row', () => {
    const { db, dir } = setup();
    try {
      const user = db.createUser('Eve', 'hash:eee');
      db.createSession(user.id, 'abc123hash', 9999999999999);
      const session = db.getSession('abc123hash');
      assert.ok(session);
      assert.equal(session.user_id, user.id);
      assert.equal(session.username, 'Eve');
      assert.equal(session.expires_at, 9999999999999);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getSession returns null for unknown token hash', () => {
    const { db, dir } = setup();
    try {
      const session = db.getSession('nonexistent');
      assert.equal(session, null);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deleteSession removes session', () => {
    const { db, dir } = setup();
    try {
      const user = db.createUser('Frank', 'hash:fff');
      db.createSession(user.id, 'token123', 9999999999999);
      db.deleteSession('token123');
      const session = db.getSession('token123');
      assert.equal(session, null);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('cleanExpiredSessions removes only expired sessions', () => {
    const { db, dir } = setup();
    try {
      const user = db.createUser('Grace', 'hash:ggg');
      db.createSession(user.id, 'expired1', 100);
      db.createSession(user.id, 'expired2', 200);
      db.createSession(user.id, 'valid1', 9999999999999);
      db.createSession(user.id, 'valid2', 9999999999999);

      const removed = db.cleanExpiredSessions(500);
      assert.equal(removed, 2);

      assert.equal(db.getSession('expired1'), null);
      assert.equal(db.getSession('expired2'), null);
      assert.ok(db.getSession('valid1'));
      assert.ok(db.getSession('valid2'));
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('store preferences: create, get, update, delete', () => {
    const { db, dir } = setup();
    try {
      const user = db.createUser('Hank', 'hash:hhh');
      db.setStorePreference(user.id, 10, 1);
      db.setStorePreference(user.id, 20, 2);

      const prefs = db.getStorePreferences(user.id);
      assert.equal(prefs.length, 2);
      assert.equal(prefs[0].context_id, 10);
      assert.equal(prefs[0].rank, 1);
      assert.equal(prefs[1].context_id, 20);
      assert.equal(prefs[1].rank, 2);

      db.setStorePreference(user.id, 10, 5);
      const updated = db.getStorePreferences(user.id);
      assert.equal(updated.find(p => p.context_id === 10).rank, 5);

      db.deleteStorePreference(user.id, 10);
      const afterDel = db.getStorePreferences(user.id);
      assert.equal(afterDel.length, 1);
      assert.equal(afterDel[0].context_id, 20);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('store preferences: ownership isolation', () => {
    const { db, dir } = setup();
    try {
      const userA = db.createUser('Alice', 'hash:a');
      const userB = db.createUser('Bob', 'hash:b');
      db.setStorePreference(userA.id, 10, 1);
      const bPrefs = db.getStorePreferences(userB.id);
      assert.equal(bPrefs.length, 0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('watch list: add, get, delete, ownership isolation', () => {
    const { db, dir } = setup();
    try {
      const userA = db.createUser('Alice', 'hash:a');
      const userB = db.createUser('Bob', 'hash:b');

      db.addWatchListEntry(userA.id, 'product', 'prod:1', 'Milk');
      db.addWatchListEntry(userA.id, 'product', 'prod:2', 'Eggs');
      db.addWatchListEntry(userB.id, 'product', 'prod:1', 'Milk');

      const aList = db.getWatchList(userA.id);
      assert.equal(aList.length, 2);
      const labels = aList.map(e => e.label).sort();
      assert.deepEqual(labels, ['Eggs', 'Milk']);

      const bList = db.getWatchList(userB.id);
      assert.equal(bList.length, 1);

      const entryId = aList[0].id;
      db.deleteWatchListEntry(entryId);
      assert.equal(db.getWatchList(userA.id).length, 1);
      assert.equal(db.getWatchList(userB.id).length, 1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('watch list: duplicate add is idempotent (ON CONFLICT DO NOTHING)', () => {
    const { db, dir } = setup();
    try {
      const user = db.createUser('Ivy', 'hash:iii');
      db.addWatchListEntry(user.id, 'product', 'prod:x', 'Dupe');
      db.addWatchListEntry(user.id, 'product', 'prod:x', 'Dupe');
      const list = db.getWatchList(user.id);
      assert.equal(list.length, 1);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saved searches: create, get, delete', () => {
    const { db, dir } = setup();
    try {
      const user = db.createUser('Jack', 'hash:jjj');
      const search = db.createSavedSearch(
        user.id, 'Milk Deals', 'milk', null, null, 'hash1'
      );
      assert.ok(search);
      assert.equal(search.name, 'Milk Deals');
      assert.equal(search.query_text, 'milk');

      const searches = db.getSavedSearches(user.id);
      assert.equal(searches.length, 1);

      db.deleteSavedSearch(search.id);
      assert.equal(db.getSavedSearches(user.id).length, 0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saved searches: duplicate normalized hash returns null', () => {
    const { db, dir } = setup();
    try {
      const user = db.createUser('Kate', 'hash:kkk');
      db.createSavedSearch(user.id, 'Search A', 'eggs', null, null, 'dupHash');
      const dupe = db.createSavedSearch(user.id, 'Search B', 'EGGS', null, null, 'dupHash');
      assert.equal(dupe, null);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('saved searches: ownership isolation', () => {
    const { db, dir } = setup();
    try {
      const userA = db.createUser('Alice', 'hash:a');
      const userB = db.createUser('Bob', 'hash:b');
      db.createSavedSearch(userA.id, 'A Search', 'test', null, null, 'h1');
      assert.equal(db.getSavedSearches(userB.id).length, 0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('new product notices: get and mark notified', () => {
    const { db, dir } = setup();
    try {
      db.db.prepare(
        'INSERT INTO new_product_notices (product_id, retailer_id, first_seen_at) VALUES (?, ?, ?)'
      ).run('prod:1', 'retailer1', 1000);
      db.db.prepare(
        'INSERT INTO new_product_notices (product_id, retailer_id, first_seen_at) VALUES (?, ?, ?)'
      ).run('prod:2', 'retailer2', 2000);

      const notices = db.getNewProductNotices();
      assert.equal(notices.length, 2);

      db.markAllNotified();
      assert.equal(db.getNewProductNotices().length, 0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles strings with apostrophes and SQL-like patterns safely', () => {
    const { db, dir } = setup();
    try {
      const user = db.createUser("O'Brien", "hash:o'brien");
      assert.ok(user);
      assert.equal(user.username, "O'Brien");

      const found = db.getUserByUsername("o'brien");
      assert.ok(found);

      db.addWatchListEntry(user.id, 'product', "prod:' OR '1'='1", "Test's label");
      const list = db.getWatchList(user.id);
      assert.equal(list.length, 1);
      assert.equal(list[0].target_id, "prod:' OR '1'='1");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('close works without error', () => {
    const { db, dir } = setup();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // ---- Product Matching ----

  it('createMatchPair inserts a pair with canonical ordering', () => {
    const { db, dir } = setup();
    try {
      const id = db.createMatchPair({
        productAId: 'nw:1',
        productBId: 'ps:1',
        matchMethod: 'auto_gtin',
        algorithmVersion: '1.0.0',
        confidence: 1.0,
        reviewState: 'confirmed',
        provenance: 'system',
        inputEvidenceHash: 'abc123',
      });
      assert.ok(id > 0);

      const pair = db.db.prepare(
        'SELECT * FROM product_match_pairs WHERE id = ?'
      ).get(id);
      assert.ok(pair);
      // Canonical ordering: nw:1 < ps:1 alphabetically
      assert.equal(pair.product_a_id, 'nw:1');
      assert.equal(pair.product_b_id, 'ps:1');
      assert.equal(pair.match_method, 'auto_gtin');
      assert.equal(pair.review_state, 'confirmed');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getMatchPair finds by canonical ordered IDs', () => {
    const { db, dir } = setup();
    try {
      db.createMatchPair({
        productAId: 'ps:1', productBId: 'nw:1',
        matchMethod: 'auto_gtin', algorithmVersion: '1.0.0',
        confidence: 1.0, reviewState: 'confirmed', provenance: 'system', inputEvidenceHash: null,
      });
      const pair = db.getMatchPair('nw:1', 'ps:1');
      assert.ok(pair);
      assert.equal(pair.product_a_id, 'nw:1');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getMatchPair returns null for nonexistent pair', () => {
    const { db, dir } = setup();
    try {
      assert.equal(db.getMatchPair('a:1', 'b:1'), null);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getMatchPairById returns null for nonexistent id', () => {
    const { db, dir } = setup();
    try {
      assert.equal(db.getMatchPairById(999), null);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('UNIQUE constraint prevents duplicate pair', () => {
    const { db, dir } = setup();
    try {
      db.createMatchPair({
        productAId: 'paknsave:1', productBId: 'newworld:1',
        matchMethod: 'auto_gtin', algorithmVersion: '1.0.0',
        confidence: 1.0, reviewState: 'confirmed', provenance: 'system', inputEvidenceHash: null,
      });
      assert.throws(() => {
        db.createMatchPair({
          productAId: 'paknsave:1', productBId: 'newworld:1',
          matchMethod: 'auto_source_id', algorithmVersion: '1.0.0',
          confidence: 1.0, reviewState: 'confirmed', provenance: 'system', inputEvidenceHash: null,
        });
      }, /UNIQUE/);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getMatchPairs filters by methods and states', () => {
    const { db, dir } = setup();
    try {
      db.createMatchPair({
        productAId: 'pa:1', productBId: 'nw:1',
        matchMethod: 'auto_gtin', algorithmVersion: '1.0.0',
        confidence: 1.0, reviewState: 'confirmed', provenance: 'system', inputEvidenceHash: null,
      });
      db.createMatchPair({
        productAId: 'pa:2', productBId: 'nw:2',
        matchMethod: 'fuzzy_candidate', algorithmVersion: '1.0.0',
        confidence: 0.5, reviewState: 'candidate', provenance: 'system', inputEvidenceHash: null,
      });

      assert.equal(db.getMatchPairs().length, 2);
      assert.equal(db.getMatchPairs({ methods: ['auto_gtin'] }).length, 1);
      assert.equal(db.getMatchPairs({ states: ['candidate'] }).length, 1);
      assert.equal(db.getMatchPairs({ methods: ['auto_gtin'], states: ['confirmed'] }).length, 1);
      assert.equal(db.getMatchPairs({ methods: ['human_reviewed'] }).length, 0);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('updateMatchPair updates fields on existing pair', () => {
    const { db, dir } = setup();
    try {
      const id = db.createMatchPair({
        productAId: 'a:1', productBId: 'b:1',
        matchMethod: 'fuzzy_candidate', algorithmVersion: '1.0.0',
        confidence: 0.4, reviewState: 'candidate', provenance: 'system', inputEvidenceHash: 'old',
      });

      db.updateMatchPair(id, {
        matchMethod: 'auto_gtin',
        confidence: 1.0,
        reviewState: 'confirmed',
        provenance: 'system',
        inputEvidenceHash: 'newhash',
      });

      const pair = db.getMatchPairById(id);
      assert.equal(pair.match_method, 'auto_gtin');
      assert.equal(pair.confidence, 1.0);
      assert.equal(pair.review_state, 'confirmed');
      assert.equal(pair.input_evidence_hash, 'newhash');
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('updateMatchReview sets user provenance and reviewer', () => {
    const { db, dir } = setup();
    try {
      const id = db.createMatchPair({
        productAId: 'a:1', productBId: 'b:1',
        matchMethod: 'fuzzy_candidate', algorithmVersion: '1.0.0',
        confidence: 0.5, reviewState: 'candidate', provenance: 'system', inputEvidenceHash: null,
      });

      db.updateMatchReview(id, 'confirmed', 'alice');
      const pair = db.getMatchPairById(id);
      assert.equal(pair.review_state, 'confirmed');
      assert.equal(pair.provenance, 'user');
      assert.equal(pair.reviewer, 'alice');
      assert.ok(pair.reviewed_at);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deleteMatchPair removes the pair', () => {
    const { db, dir } = setup();
    try {
      const id = db.createMatchPair({
        productAId: 'a:1', productBId: 'b:1',
        matchMethod: 'fuzzy_candidate', algorithmVersion: '1.0.0',
        confidence: 0.5, reviewState: 'candidate', provenance: 'system', inputEvidenceHash: null,
      });
      assert.ok(db.getMatchPairById(id));
      db.deleteMatchPair(id);
      assert.equal(db.getMatchPairById(id), null);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('handles SQL-like strings safely in matching methods', () => {
    const { db, dir } = setup();
    try {
      const id = db.createMatchPair({
        productAId: "o'brien:1", productBId: "test:' OR '1'='1",
        matchMethod: 'auto_gtin', algorithmVersion: '1.0.0',
        confidence: 1.0, reviewState: 'confirmed', provenance: 'system', inputEvidenceHash: null,
      });
      const pair = db.getMatchPairById(id);
      assert.equal(pair.product_a_id, "o'brien:1");
      assert.equal(pair.product_b_id, "test:' OR '1'='1");
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
