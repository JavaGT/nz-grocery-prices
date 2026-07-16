import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ProjectionRepository } from '../../src/sqlite/projection-repository.js';
import { JsonlObservationRepository } from '../../src/repository.js';

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'proj-repo-'));
  return { dir: d };
}

function v2product(productId, data = {}, overrides = {}) {
  return JSON.stringify({
    version: 2,
    type: 'product',
    productId,
    hash: overrides.hash || 'a'.repeat(64),
    observedAt: overrides.observedAt || '2026-07-13T12:00:00.000Z',
    data: {
      name: 'Test Product',
      brand: 'Test Brand',
      categories: ['Groceries'],
      ...data,
    },
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
    data: {
      id: storeId,
      retailer,
      name: 'Test Store',
      ...data,
    },
  });
}

function v2offer(productId, storeId, priceData = {}, extra = {}) {
  const offerId = `${productId}\x00${storeId}`;
  return JSON.stringify({
    version: 2,
    type: 'offer',
    offerId,
    productId,
    storeId,
    hash: extra.hash || 'c'.repeat(64),
    observedAt: extra.observedAt || '2026-07-13T12:00:00.000Z',
    data: {
      price: {
        regularCents: 1000,
        ...priceData,
      },
      source: {
        retailerProductId: productId.split(':').pop(),
        adapter: 'test',
        url: 'https://example.com',
        ...extra.source,
      },
      ...(extra.promotion ? { promotion: extra.promotion } : {}),
    },
  });
}

function v2snapshot(storeId, added = [], removed = [], overrides = {}) {
  const retailer = storeId.split(':')[0];
  return JSON.stringify({
    version: 2,
    type: 'snapshot',
    scope: 'specials',
    storeId,
    observedAt: overrides.observedAt || '2026-07-13T12:00:00.000Z',
    offerCount: added.length,
    offersHash: overrides.offersHash || 'd'.repeat(64),
    added,
    removed,
  });
}

describe('ProjectionRepository lifecycle', () => {
  it('constructor sets jsonlPath and dbPath', () => {
    const { dir } = tmp();
    try {
      const r = new ProjectionRepository('/tmp/a.jsonl', join(dir, 'b.db'));
      assert.equal(r.jsonlPath, '/tmp/a.jsonl');
      assert.equal(r.dbPath, join(dir, 'b.db'));
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('open() creates a DatabaseSync and sets .db', () => {
    const { dir } = tmp();
    const dbPath = join(dir, 'test.db');
    try {
      const r = new ProjectionRepository('/nonexistent.jsonl', dbPath);
      r.open();
      assert.ok(r.db, '.db should be set');
      assert.ok(r.db instanceof DatabaseSync);
      r.close();
      assert.equal(r.db, null);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('open(extDb) accepts an external DatabaseSync', () => {
    const { dir } = tmp();
    try {
      const ext = new DatabaseSync(join(dir, 'ext.db'));
      const r = new ProjectionRepository('/nonexistent.jsonl', join(dir, 'ignored.db'));
      r.open(ext);
      assert.equal(r.db, ext);
      assert.ok(r.db instanceof DatabaseSync);
      r.close();
      assert.equal(r.db, null);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('open/open/reopen is safe', () => {
    const { dir } = tmp();
    const dbPath = join(dir, 'safe.db');
    try {
      const r = new ProjectionRepository('/nonexistent.jsonl', dbPath);
      r.open();
      const db1 = r.db;
      r.open(); // re-open — creates new connection
      const db2 = r.db;
      assert.notEqual(db1, db2);
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('query() throws when not open', () => {
    const { dir } = tmp();
    try {
      const r = new ProjectionRepository('/nonexistent.jsonl', join(dir, 'nope.db'));
      assert.throws(() => r.query(), { message: /not open/ });
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('productHistory() throws when not open', () => {
    const { dir } = tmp();
    try {
      const r = new ProjectionRepository('/nonexistent.jsonl', join(dir, 'nope.db'));
      assert.throws(() => r.productHistory('x'), { message: /not open/ });
    } finally { rmSync(dir, { recursive: true }); }
  });
});

describe('ProjectionRepository rebuild', () => {
  it('rebuild returns {status:"rebuilt"} with recordsImported=0 for empty archive', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'empty.jsonl');
    const dbPath = join(dir, 'empty.db');
    writeFileSync(jsonlPath, '');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      const result = r.rebuild();
      assert.equal(result.status, 'rebuilt');
      assert.equal(result.recordsImported, 0);
      assert.equal(result.errors, 0);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('rebuild handles blank-only archive', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'blanks.jsonl');
    const dbPath = join(dir, 'blanks.db');
    writeFileSync(jsonlPath, '\n\n\n\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      const result = r.rebuild();
      assert.equal(result.status, 'rebuilt');
      assert.equal(result.recordsImported, 0);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('rebuild inserts one product record', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'one.jsonl');
    const dbPath = join(dir, 'one.db');
    writeFileSync(jsonlPath, v2product('test:p1', { name: 'One Product' }) + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const rows = r.db.prepare('SELECT id, name, retailer_id FROM products').all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, 'test:p1');
      assert.equal(rows[0].name, 'One Product');
      assert.equal(rows[0].retailer_id, 'test');
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('rebuild inserts product + store + offer and query returns observation', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'full.jsonl');
    const dbPath = join(dir, 'full.db');
    writeFileSync(jsonlPath, [
      v2product('paknsave:123', { name: 'Milk', brand: 'Anchor' }),
      v2store('paknsave:s1', { name: 'PAKnSAVE Royal Oak', address: '691 Manukau Rd', region: 'Auckland' }),
      v2offer('paknsave:123', 'paknsave:s1', { regularCents: 550 }),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const observations = r.query();
      assert.equal(observations.length, 1);
      const o = observations[0];
      assert.equal(o.product.id, 'paknsave:123');
      assert.equal(o.product.name, 'Milk');
      assert.equal(o.store.id, 'paknsave:s1');
      assert.equal(o.store.name, 'PAKnSAVE Royal Oak');
      assert.equal(o.store.retailer, 'paknsave');
      assert.equal(o.price.regularCents, 550);
      assert.equal(o.source.retailerProductId, '123');
      assert.equal(o.source.adapter, 'test');
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('query returns empty array when no offers match', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'emptyq.jsonl');
    const dbPath = join(dir, 'emptyq.db');
    writeFileSync(jsonlPath, [
      v2product('p:1', { name: 'P1' }),
      v2store('p:s1', { name: 'S1' }),
      v2offer('p:1', 'p:s1', { regularCents: 500 }),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const results = r.query({ productId: 'nonexistent' });
      assert.deepEqual(results, []);
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('time filtering: from/to filters correctly', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'time.jsonl');
    const dbPath = join(dir, 'time.db');
    const early = '2026-07-01T12:00:00.000Z';
    const late = '2026-07-15T12:00:00.000Z';
    writeFileSync(jsonlPath, [
      v2product('p:1', { name: 'Early' }, { observedAt: early }),
      v2product('p:2', { name: 'Late' }, { observedAt: late }),
      v2store('r:s1', {}, { observedAt: early }),
      v2store('r:s1', {}, { observedAt: late }),
      v2offer('p:1', 'r:s1', { regularCents: 100 }, { observedAt: early }),
      v2offer('p:2', 'r:s1', { regularCents: 200 }, { observedAt: late }),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const earlyOnly = r.query({ from: '2026-07-01T00:00:00.000Z', to: '2026-07-10T00:00:00.000Z' });
      assert.equal(earlyOnly.length, 1);
      assert.equal(earlyOnly[0].price.regularCents, 100);
      const lateOnly = r.query({ from: '2026-07-10T00:00:00.000Z', to: '2026-07-20T00:00:00.000Z' });
      assert.equal(lateOnly.length, 1);
      assert.equal(lateOnly[0].price.regularCents, 200);
      const all = r.query({ from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' });
      assert.equal(all.length, 2);
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('filters by productId', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'fp.jsonl');
    const dbPath = join(dir, 'fp.db');
    writeFileSync(jsonlPath, [
      v2product('r:p1', { name: 'P1' }),
      v2product('r:p2', { name: 'P2' }),
      v2store('r:s1', {}),
      v2offer('r:p1', 'r:s1', { regularCents: 100 }),
      v2offer('r:p2', 'r:s1', { regularCents: 200 }),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const results = r.query({ productId: 'r:p1' });
      assert.equal(results.length, 1);
      assert.equal(results[0].price.regularCents, 100);
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('filters by storeId', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'fs.jsonl');
    const dbPath = join(dir, 'fs.db');
    writeFileSync(jsonlPath, [
      v2product('r:p1', { name: 'P1' }),
      v2store('r:s1', { name: 'Store 1' }),
      v2store('r:s2', { name: 'Store 2' }),
      v2offer('r:p1', 'r:s1', { regularCents: 100 }),
      v2offer('r:p1', 'r:s2', { regularCents: 200 }),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const results = r.query({ storeId: 'r:s2' });
      assert.equal(results.length, 1);
      assert.equal(results[0].price.regularCents, 200);
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('filters by retailer', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'fr.jsonl');
    const dbPath = join(dir, 'fr.db');
    writeFileSync(jsonlPath, [
      v2product('r1:p1', { name: 'P1' }),
      v2product('r2:p2', { name: 'P2' }),
      v2store('r1:s1', {}),
      v2store('r2:s1', {}),
      v2offer('r1:p1', 'r1:s1', { regularCents: 100 }),
      v2offer('r2:p2', 'r2:s1', { regularCents: 200 }),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const results = r.query({ retailer: 'r2' });
      assert.equal(results.length, 1);
      assert.equal(results[0].price.regularCents, 200);
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('productHistory returns revision history for a product', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'hist.jsonl');
    const dbPath = join(dir, 'hist.db');
    writeFileSync(jsonlPath, [
      v2product('r:p1', { name: 'P1 v1', brand: 'A' }, { hash: 'h1' + '0'.repeat(62), observedAt: '2026-07-01T12:00:00.000Z' }),
      v2product('r:p1', { name: 'P1 v2', brand: 'B' }, { hash: 'h2' + '0'.repeat(62), observedAt: '2026-07-15T12:00:00.000Z' }),
      v2store('r:s1', {}),
      v2offer('r:p1', 'r:s1', { regularCents: 100 }, { hash: 'h3' + '0'.repeat(62), observedAt: '2026-07-01T12:00:00.000Z' }),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const history = r.productHistory('r:p1');
      assert.equal(history.length, 2);
      assert.equal(history[0].product.name, 'P1 v2');
      assert.equal(history[0].hash, 'h2' + '0'.repeat(62));
      assert.equal(history[1].product.name, 'P1 v1');
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('productHistory returns empty array for unknown product', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'phempty.jsonl');
    const dbPath = join(dir, 'phempty.db');
    writeFileSync(jsonlPath, v2product('r:p1', { name: 'P1' }) + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      assert.deepEqual(r.productHistory('r:unknown'), []);
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('duplicate product revision (same hash) is ignored', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'dedup.jsonl');
    const dbPath = join(dir, 'dedup.db');
    const hash = 'h1' + '0'.repeat(62);
    writeFileSync(jsonlPath, [
      v2product('r:p1', { name: 'P1' }, { hash, observedAt: '2026-07-01T12:00:00.000Z' }),
      v2product('r:p1', { name: 'P1' }, { hash, observedAt: '2026-07-15T12:00:00.000Z' }),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const revisions = r.db.prepare('SELECT COUNT(*) AS cnt FROM product_revisions WHERE hash = ?').get(hash);
      assert.equal(revisions.cnt, 1, 'duplicate revision hash should be ignored via INSERT OR IGNORE');
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('duplicate offer (same offer_key + rev_hash + observed_at) is ignored', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'dedup-offer.jsonl');
    const dbPath = join(dir, 'dedup-offer.db');
    writeFileSync(jsonlPath, [
      v2product('r:p1', { name: 'P1' }),
      v2store('r:s1', {}),
      v2offer('r:p1', 'r:s1', { regularCents: 500 }, { hash: 'x'.repeat(64) }),
      v2offer('r:p1', 'r:s1', { regularCents: 500 }, { hash: 'x'.repeat(64) }),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const cnt = r.db.prepare('SELECT COUNT(*) AS cnt FROM offer_revisions').get();
      assert.equal(cnt.cnt, 1, 'duplicate offer (UNIQUE constraint) should be ignored');
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('retailers table auto-populates with correct names', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'retailers.jsonl');
    const dbPath = join(dir, 'retailers.db');
    writeFileSync(jsonlPath, [
      v2product('paknsave:p1', { name: 'P1' }),
      v2product('newworld:p2', { name: 'P2' }),
      v2product('woolworths:p3', { name: 'P3' }),
      v2product('freshchoice:p4', { name: 'P4' }),
      v2product('warehouse:p5', { name: 'P5' }),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const retailers = r.db.prepare('SELECT id, name FROM retailers ORDER BY id').all().map(r => Object.assign({}, r));
      assert.deepEqual(retailers, [
        { id: 'freshchoice', name: 'FreshChoice' },
        { id: 'newworld', name: 'New World' },
        { id: 'paknsave', name: "PAK'nSAVE" },
        { id: 'warehouse', name: 'The Warehouse' },
        { id: 'woolworths', name: 'Woolworths' },
      ]);
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('retailer count in query results matches distinct retailers', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'rcount.jsonl');
    const dbPath = join(dir, 'rcount.db');
    writeFileSync(jsonlPath, [
      v2product('paknsave:p1', { name: 'P1' }),
      v2product('newworld:p2', { name: 'P2' }),
      v2store('paknsave:s1', {}),
      v2store('newworld:s1', {}),
      v2offer('paknsave:p1', 'paknsave:s1', { regularCents: 100 }),
      v2offer('newworld:p2', 'newworld:s1', { regularCents: 200 }),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const observations = r.query();
      const retailers = new Set(observations.map(o => o.store.retailer));
      assert.equal(retailers.size, 2);
      assert.ok(retailers.has('paknsave'));
      assert.ok(retailers.has('newworld'));
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });
});

describe('best-image normalization', () => {
  it('image_url from data.image_url takes priority over data.images', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'img1.jsonl');
    const dbPath = join(dir, 'img1.db');
    writeFileSync(jsonlPath, v2product('r:p1', {
      name: 'P1',
      image_url: 'https://example.com/primary.jpg',
      images: ['https://example.com/fallback.jpg'],
    }) + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const row = r.db.prepare('SELECT image_url FROM products WHERE id = ?').get('r:p1');
      assert.equal(row.image_url, 'https://example.com/primary.jpg');
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('bestImage picks first truthy from array when image_url absent', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'img2.jsonl');
    const dbPath = join(dir, 'img2.db');
    writeFileSync(jsonlPath, v2product('r:p1', {
      name: 'P1',
      images: ['https://example.com/a.jpg', 'https://example.com/b.jpg'],
    }) + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const row = r.db.prepare('SELECT image_url FROM products WHERE id = ?').get('r:p1');
      assert.equal(row.image_url, 'https://example.com/a.jpg');
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('bestImage picks highest-resolution key from images object', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'img3.jsonl');
    const dbPath = join(dir, 'img3.db');
    writeFileSync(jsonlPath, v2product('r:p1', {
      name: 'P1',
      images: {
        '100': 'https://example.com/small.jpg',
        '400': 'https://example.com/medium.jpg',
        '800': 'https://example.com/large.jpg',
      },
    }) + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const row = r.db.prepare('SELECT image_url FROM products WHERE id = ?').get('r:p1');
      assert.equal(row.image_url, 'https://example.com/large.jpg');
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('bestImage returns null when no images', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'img4.jsonl');
    const dbPath = join(dir, 'img4.db');
    writeFileSync(jsonlPath, v2product('r:p1', { name: 'NoImg' }) + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const row = r.db.prepare('SELECT image_url FROM products WHERE id = ?').get('r:p1');
      assert.equal(row.image_url, null);
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('bestImage handles string images field', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'img5.jsonl');
    const dbPath = join(dir, 'img5.db');
    writeFileSync(jsonlPath, v2product('r:p1', {
      name: 'P1',
      images: 'https://example.com/string.jpg',
    }) + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const row = r.db.prepare('SELECT image_url FROM products WHERE id = ?').get('r:p1');
      assert.equal(row.image_url, 'https://example.com/string.jpg');
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });
});

describe('promotion and source data', () => {
  it('offer with promotion data is stored and returned', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'promo.jsonl');
    const dbPath = join(dir, 'promo.db');
    writeFileSync(jsonlPath, [
      v2product('r:p1', { name: 'Promo Product' }),
      v2store('r:s1', {}),
      v2offer('r:p1', 'r:s1', { regularCents: 1000, promoCents: 750 }, {
        promotion: { id: 'promo1', type: 'SPECIAL', savePercent: 25 },
      }),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const obs = r.query();
      assert.equal(obs.length, 1);
      assert.equal(obs[0].price.regularCents, 1000);
      assert.equal(obs[0].price.promoCents, 750);
      assert.ok(obs[0].promotion);
      assert.equal(obs[0].promotion.type, 'SPECIAL');
      assert.equal(obs[0].promotion.savePercent, 25);
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('offer with memberCents is returned', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'member.jsonl');
    const dbPath = join(dir, 'member.db');
    writeFileSync(jsonlPath, [
      v2product('r:p1', { name: 'Member Price Item' }),
      v2store('r:s1', {}),
      v2offer('r:p1', 'r:s1', { regularCents: 1000, memberCents: 850 }),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const obs = r.query();
      assert.equal(obs[0].price.memberCents, 850);
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('source data with adapter and url is returned', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'source.jsonl');
    const dbPath = join(dir, 'source.db');
    writeFileSync(jsonlPath, [
      v2product('r:p1', { name: 'P1' }),
      v2store('r:s1', {}),
      v2offer('r:p1', 'r:s1', { regularCents: 999 }, {
        source: { retailerProductId: 'ext-42', adapter: 'testAdapter', url: 'https://x.com/p1' },
      }),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const obs = r.query();
      assert.equal(obs[0].source.adapter, 'testAdapter');
      assert.equal(obs[0].source.url, 'https://x.com/p1');
      assert.equal(obs[0].source.retailerProductId, 'ext-42');
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });
});

describe('special listing snapshots', () => {
  it('query returns isOnSpecial:true for offers in active listing', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'snap.jsonl');
    const dbPath = join(dir, 'snap.db');
    const offerKey1 = 'r:p1\x00r:s1';
    writeFileSync(jsonlPath, [
      v2product('r:p1', { name: 'P1' }),
      v2store('r:s1', {}),
      v2offer('r:p1', 'r:s1', { regularCents: 500 }),
      v2snapshot('r:s1', [offerKey1], []),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const obs = r.query();
      assert.equal(obs.length, 1);
      assert.equal(obs[0].isOnSpecial, true);
      assert.ok(obs[0].lastSeenAt);
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('query returns isOnSpecial:false for offers not in active listing when snapshots exist', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'snap2.jsonl');
    const dbPath = join(dir, 'snap2.db');
    const offerKey1 = 'r:p1\x00r:s1';
    writeFileSync(jsonlPath, [
      v2product('r:p1', { name: 'P1' }),
      v2store('r:s1', {}),
      v2offer('r:p1', 'r:s1', { regularCents: 500 }),
      v2snapshot('r:s1', [], [offerKey1]),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const obs = r.query();
      assert.equal(obs.length, 1);
      assert.equal(obs[0].isOnSpecial, false);
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('query omits isOnSpecial when no snapshots exist for that store', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'nosnap.jsonl');
    const dbPath = join(dir, 'nosnap.db');
    writeFileSync(jsonlPath, [
      v2product('r:p1', { name: 'P1' }),
      v2store('r:s1', {}),
      v2offer('r:p1', 'r:s1', { regularCents: 500 }),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const obs = r.query();
      assert.equal(obs.length, 1);
      assert.equal(obs[0].isOnSpecial, undefined);
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });
});

describe('equivalence with JsonlObservationRepository', () => {
  function makeObs(prefix, idx, time) {
    const t = time || new Date(Date.now() - idx * 86400000).toISOString();
    return {
      product: {
        id: `${prefix}:p${idx}`,
        name: `Product ${idx}`,
        brand: `Brand ${idx}`,
        categories: idx === 1 ? ['Dairy', 'Milk'] : ['Groceries'],
        images: idx === 1 ? { primary: `https://img.example.com/${idx}.jpg` } : [],
        gtin: idx === 1 ? '9400123456789' : undefined,
      },
      store: {
        id: `${prefix}:s${idx % 2 + 1}`,
        retailer: prefix,
        name: `Store ${idx % 2 + 1}`,
      },
      price: {
        regularCents: 500 + idx * 100,
        ...(idx === 2 ? { promoCents: 400 } : {}),
      },
      source: {
        retailerProductId: `ext-${idx}`,
        adapter: `${prefix}-adapter`,
        url: `https://shop.example.com/p${idx}`,
      },
      observedAt: t,
    };
  }

  it('produces same observation count and key fields as JsonlObservationRepository', async () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'equiv.jsonl');
    const dbPath = join(dir, 'equiv.db');

    const jsonlRepo = new JsonlObservationRepository(jsonlPath);
    const obsData = [1, 2, 3].map(i => makeObs('eqtest', i));

    await jsonlRepo.append(obsData, { snapshotScope: 'specials' });

    const r = new ProjectionRepository(jsonlPath, dbPath);
    const rebuildResult = r.rebuild();
    assert.equal(rebuildResult.status, 'rebuilt');

    r.open();
    const sqliteResults = r.query();

    const jsonlResults = await jsonlRepo.query();

    assert.equal(sqliteResults.length, jsonlResults.length,
      `expected ${jsonlResults.length} observations, got ${sqliteResults.length}`);

    for (let i = 0; i < sqliteResults.length; i++) {
      const s = sqliteResults[i];
      const j = jsonlResults[i];
      assert.equal(s.product.id, j.product.id, `product.id at index ${i}`);
      assert.equal(s.store.id, j.store.id, `store.id at index ${i}`);
      assert.equal(s.price.regularCents, j.price.regularCents, `regularCents at index ${i}`);
      if (j.price.promoCents != null) {
        assert.equal(s.price.promoCents, j.price.promoCents, `promoCents at index ${i}`);
      }
      assert.equal(s.source.adapter, j.source.adapter, `source.adapter at index ${i}`);
    }

    r.close();
    rmSync(dir, { recursive: true });
  });

  it('equivalence with multi-retailer store-store scenario', async () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'equiv2.jsonl');
    const dbPath = join(dir, 'equiv2.db');

    const jsonlRepo = new JsonlObservationRepository(jsonlPath);
    const now = new Date('2026-07-15T12:00:00.000Z');

    const obsList = [
      {
        product: { id: 'brandx:milk1', name: 'Whole Milk 1L', brand: 'Brand X', categories: ['Dairy'], gtin: '00001', images: ['https://img.com/milk.jpg'] },
        store: { id: 'brandx:store-001', retailer: 'brandx', name: 'Brand X Downtown' },
        price: { regularCents: 599, promoCents: 499 },
        source: { retailerProductId: 'milk1', adapter: 'brandx-adapter', url: 'https://brandx.com/milk1' },
        observedAt: now.toISOString(),
      },
      {
        product: { id: 'brandy:eggs12', name: 'Free Range Eggs 12pk', brand: 'Brand Y', categories: ['Dairy', 'Eggs'], images: [] },
        store: { id: 'brandy:store-001', retailer: 'brandy', name: 'Brand Y Mall' },
        price: { regularCents: 1299 },
        source: { retailerProductId: 'eggs12', adapter: 'brandy-adapter', url: 'https://brandy.com/eggs12' },
        observedAt: now.toISOString(),
      },
    ];

    await jsonlRepo.append(obsList, { snapshotScope: 'specials' });

    const r = new ProjectionRepository(jsonlPath, dbPath);
    r.rebuild();
    r.open();
    const sqliteResults = r.query();
    const jsonlResults = await jsonlRepo.query();

    assert.equal(sqliteResults.length, jsonlResults.length);
    for (let i = 0; i < sqliteResults.length; i++) {
      const s = sqliteResults[i];
      const j = jsonlResults[i];
      assert.equal(s.product.id, j.product.id);
      assert.equal(s.store.id, j.store.id);
      assert.equal(s.store.retailer, j.store.retailer);
      assert.equal(s.price.regularCents, j.price.regularCents);
      assert.equal(s.source.adapter, j.source.adapter);
    }

    r.close();
    rmSync(dir, { recursive: true });
  });
});

describe('import_runs metadata', () => {
  it('rebuild records import run details', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'meta.jsonl');
    const dbPath = join(dir, 'meta.db');
    writeFileSync(jsonlPath, [
      v2product('r:p1', { name: 'P1' }),
      v2store('r:s1', {}),
      v2offer('r:p1', 'r:s1', { regularCents: 500 }),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const runs = r.db.prepare('SELECT * FROM import_runs ORDER BY id DESC').all();
      assert.equal(runs.length, 1);
      assert.equal(runs[0].status, 'completed');
      assert.equal(runs[0].records_imported, 3);
      assert.equal(runs[0].errors, 0);
      assert.equal(runs[0].jsonl_path, jsonlPath);
      assert.equal(typeof runs[0].jsonl_hash, 'string');
      assert.equal(runs[0].jsonl_hash.length, 64);
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('rebuild stores _meta fingerprint and records count', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'meta2.jsonl');
    const dbPath = join(dir, 'meta2.db');
    writeFileSync(jsonlPath, [
      v2product('r:p1', { name: 'P1' }),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const meta = r.db.prepare('SELECT key, value FROM _meta').all();
      const map = Object.fromEntries(meta.map(m => [m.key, m.value]));
      assert.ok(map.jsonl_fingerprint);
      assert.equal(map.jsonl_fingerprint.length, 64);
      assert.equal(map.records_imported, '1');
      assert.equal(map.error_count, '0');
      assert.equal(map.jsonl_path, jsonlPath);
      assert.ok(map.built_at);
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });
});
