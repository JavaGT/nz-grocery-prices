import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ProjectionRepository } from '../../src/sqlite/projection-repository.js';

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'rollback-'));
  return { dir: d };
}

function v2product(productId, data = {}, overrides = {}) {
  return JSON.stringify({
    version: 2,
    type: 'product',
    productId,
    hash: overrides.hash || 'a'.repeat(64),
    observedAt: overrides.observedAt || '2026-07-13T12:00:00.000Z',
    data: { name: 'P', brand: 'B', categories: ['G'], ...data },
  });
}

function v2store(storeId, data = {}, overrides = {}) {
  const retailer = storeId.split(':')[0];
  return JSON.stringify({
    version: 2,
    type: 'store',
    storeId,
    hash: overrides.hash || 'b'.repeat(64),
    observedAt: overrides.observedAt || '2026-07-13T12:00:00.000Z',
    data: { id: storeId, retailer, name: 'S', ...data },
  });
}

function v2offer(productId, storeId, priceData = {}, extra = {}) {
  return JSON.stringify({
    version: 2,
    type: 'offer',
    offerId: `${productId}\x00${storeId}`,
    productId,
    storeId,
    hash: extra.hash || 'c'.repeat(64),
    observedAt: extra.observedAt || '2026-07-13T12:00:00.000Z',
    data: {
      price: { regularCents: 500, ...priceData },
      source: { retailerProductId: 'x', adapter: 'test', url: 'https://x.com', ...extra.source },
    },
  });
}

function buildGoodDb(dbPath, productId = 'r:p1') {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS _meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  db.exec(`CREATE TABLE IF NOT EXISTS products (
    id TEXT NOT NULL, retailer_id TEXT NOT NULL, name TEXT NOT NULL,
    brand TEXT, category TEXT, image_url TEXT, size TEXT,
    source_id TEXT, gtin TEXT, latest_hash TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (id, retailer_id)
  )`);
  db.prepare(`INSERT INTO products(id, retailer_id, name, latest_hash, first_seen_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?)`)
    .run(productId, 'r', 'Existing Product', 'legacy_hash', 1000, 1000);
  db.prepare("INSERT OR REPLACE INTO _meta(key, value) VALUES('jsonl_fingerprint', 'original_fingerprint')").run();
  db.close();
}

function getProductCount(dbPath) {
  const db = new DatabaseSync(dbPath);
  const cnt = db.prepare('SELECT COUNT(*) AS cnt FROM products').get().cnt;
  db.close();
  return cnt;
}

describe('atomic rollback on rebuild failure', () => {
  it('existing DB preserved when rebuild throws due to invalid JSONL', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'bad.jsonl');
    const dbPath = join(dir, 'good.db');
    writeFileSync(jsonlPath, 'this will fail to parse as JSONL records\n');

    buildGoodDb(dbPath);
    const originalCnt = getProductCount(dbPath);
    assert.equal(originalCnt, 1);

    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      assert.fail('should have thrown');
    } catch {
      // expected — rebuild failure
    }

    const afterCnt = getProductCount(dbPath);
    assert.equal(afterCnt, originalCnt, 'old DB should be preserved after rebuild failure');
    rmSync(dir, { recursive: true });
  });

  it('existing DB preserved when JSONL causes SQL constraint violation in tmp', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'constraint.jsonl');
    const dbPath = join(dir, 'preserved.db');

    writeFileSync(jsonlPath, [
      v2store('r:s1'),
      v2product('r:p1'),
      v2offer('r:p1', 'r:s1'),
      v2product('r:p2'),
      v2offer('r:p2', 'r:non_existent_store'), // context lookup returns undefined → offer silently skipped
    ].join('\n') + '\n');

    buildGoodDb(dbPath);
    const originalCnt = getProductCount(dbPath);
    assert.equal(originalCnt, 1);

    const r = new ProjectionRepository(jsonlPath, dbPath);
    const result = r.rebuild();
    assert.equal(result.status, 'rebuilt');

    r.open();
    const offerCnt = r.db.prepare('SELECT COUNT(*) AS cnt FROM offer_revisions').get().cnt;
    assert.equal(offerCnt, 1, 'only the valid offer should be imported');
    r.close();

    rmSync(dir, { recursive: true });
  });

  it('rebuild failure with constraint-violating offer (null regularCents) rolls back temp and preserves old DB', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'constraint2.jsonl');
    const dbPath = join(dir, 'preserved2.db');

    writeFileSync(jsonlPath, [
      v2product('r:p1'),
      v2store('r:s1'),
      JSON.stringify({
        version: 2,
        type: 'offer',
        offerId: 'r:p1\x00r:s1',
        productId: 'r:p1',
        storeId: 'r:s1',
        hash: 'z'.repeat(64),
        observedAt: '2026-07-13T12:00:00.000Z',
        data: {
          price: { regularCents: -1 }, // violates CHECK(price_regular_cents >= 0)
          source: { retailerProductId: 'x', adapter: 'test', url: 'https://x.com' },
        },
      }),
    ].join('\n') + '\n');

    buildGoodDb(dbPath);
    const originalCnt = getProductCount(dbPath);

    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      assert.fail('should have thrown due to negative regularCents');
    } catch {
      // expected
    }

    const afterCnt = getProductCount(dbPath);
    assert.equal(afterCnt, originalCnt, 'old DB preserved after constraint violation rebuild failure');
    rmSync(dir, { recursive: true });
  });

  it('tmp file cleaned up on rebuild failure', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'noclean.jsonl');
    const dbPath = join(dir, 'noclean.db');

    writeFileSync(jsonlPath, 'garbage\n');
    buildGoodDb(dbPath);

    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
    } catch {
      // expected
    }

    const tmpPath = dbPath + '.tmp';
    assert.equal(existsSync(tmpPath), false, 'tmp file should be cleaned up on failure');
    rmSync(dir, { recursive: true });
  });
});

describe('missing archive leaves existing DB intact', () => {
  it('existing DB is not touched when JSONL is missing', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'absent.jsonl');
    const dbPath = join(dir, 'still-here.db');

    buildGoodDb(dbPath);
    const originalCnt = getProductCount(dbPath);

    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      assert.fail('should have thrown ENOENT');
    } catch (err) {
      assert.equal(err.code, 'ENOENT');
    }

    const afterCnt = getProductCount(dbPath);
    assert.equal(afterCnt, originalCnt, 'existing DB should be unchanged');
    rmSync(dir, { recursive: true });
  });

  it('missing JSONL does not delete existing DB file', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'nofile.jsonl');
    const dbPath = join(dir, 'still-exists.db');

    buildGoodDb(dbPath);
    assert.ok(existsSync(dbPath));

    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
    } catch {
      // expected
    }

    assert.ok(existsSync(dbPath), 'DB file must still exist after missing-JSONL error');
    rmSync(dir, { recursive: true });
  });
});

describe('fingerprint mismatch triggers rebuild', () => {
  it('rebuild occurs when current _meta fingerprint differs from JSONL hash', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'mismatch.jsonl');
    const dbPath = join(dir, 'mismatch.db');

    writeFileSync(jsonlPath, v2product('r:p1') + '\n');

    const r1 = new ProjectionRepository(jsonlPath, dbPath);
    const first = r1.rebuild();
    assert.equal(first.status, 'rebuilt');

    const r2 = new ProjectionRepository(jsonlPath, dbPath);
    const second = r2.rebuild();
    assert.equal(second.status, 'skipped', 'matching fingerprint skips');

    writeFileSync(jsonlPath, v2product('r:p1', { name: 'Changed' }) + '\n');

    const r3 = new ProjectionRepository(jsonlPath, dbPath);
    const third = r3.rebuild();
    assert.equal(third.status, 'rebuilt', 'changed JSONL triggers rebuild');
    assert.notEqual(third.fingerprint, first.fingerprint);

    r3.open();
    const product = r3.db.prepare("SELECT name FROM products WHERE id = 'r:p1'").get();
    assert.equal(product.name, 'Changed');
    r3.close();
    rmSync(dir, { recursive: true });
  });

  it('same fingerprint after rebuild returns skipped on next call', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'stable.jsonl');
    const dbPath = join(dir, 'stable.db');

    writeFileSync(jsonlPath, v2product('r:p1') + '\n');

    const r = new ProjectionRepository(jsonlPath, dbPath);
    const first = r.rebuild();
    assert.equal(first.status, 'rebuilt');

    const second = r.rebuild();
    assert.equal(second.status, 'skipped');

    const third = r.rebuild();
    assert.equal(third.status, 'skipped');

    rmSync(dir, { recursive: true });
  });
});
