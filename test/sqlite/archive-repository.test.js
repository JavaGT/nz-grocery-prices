import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteArchiveRepository } from '../../src/sqlite/archive-repository.js';
import { createObservationRepository } from '../../src/archive-factory.js';
import { JsonlObservationRepository } from '../../src/repository.js';

function tmpDir() {
  return mkdtempSync(join(tmpdir(), 'archive-repo-'));
}

function obs(overrides = {}) {
  return {
    product: {
      id: overrides.productId ?? 'paknsave:p1',
      name: overrides.productName ?? 'Milk 2L',
      brand: 'Anchor',
      categories: ['Dairy'],
      images: [],
    },
    store: {
      id: overrides.storeId ?? 'paknsave:s1',
      retailer: overrides.retailer ?? 'paknsave',
      name: overrides.storeName ?? 'Royal Oak',
    },
    price: {
      regularCents: overrides.regularCents ?? 500,
      ...(overrides.promoCents != null ? { promoCents: overrides.promoCents } : {}),
    },
    source: {
      retailerProductId: 'p1',
      adapter: 'test',
      url: 'https://example.com/p1',
    },
    observedAt: overrides.observedAt ?? '2026-07-17T12:00:00.000Z',
    ...(overrides.promotion ? { promotion: overrides.promotion } : {}),
  };
}

describe('SqliteArchiveRepository', () => {
  const dirs = [];
  after(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
    }
  });

  function open() {
    const dir = tmpDir();
    dirs.push(dir);
    const path = join(dir, 'archive.db');
    return { dir, path, repo: new SqliteArchiveRepository(path) };
  }

  it('appends change-only product/store/offer rows', async () => {
    const { repo } = open();
    try {
      const n1 = await repo.append([obs({ regularCents: 500 })], { snapshotScope: 'specials' });
      assert.ok(n1 >= 3, `expected product+store+offer+snapshot, got ${n1}`);
      const n2 = await repo.append([obs({ regularCents: 500 })], { snapshotScope: 'specials' });
      // Unchanged offer → snapshot only (or zero if listing identical)
      assert.ok(n2 <= 1, `unchanged offer should not re-insert, got ${n2}`);
      const n3 = await repo.append([obs({ regularCents: 400 })], { snapshotScope: 'specials' });
      assert.ok(n3 >= 1, 'price change inserts offer revision');
      const stats = repo.stats();
      assert.equal(stats.products, 1);
      assert.equal(stats.stores, 1);
      assert.equal(stats.offers, 2);
    } finally {
      repo.close();
    }
  });

  it('query returns observations and productHistory', async () => {
    const { repo } = open();
    try {
      await repo.append([
        obs({ regularCents: 500, observedAt: '2026-07-01T00:00:00.000Z' }),
        obs({ regularCents: 400, observedAt: '2026-07-10T00:00:00.000Z' }),
      ], { snapshotScope: 'specials' });

      const all = await repo.query({});
      assert.equal(all.length, 2);
      assert.equal(all[0].price.regularCents, 500);
      assert.equal(all[1].price.regularCents, 400);
      assert.equal(all[0].product.name, 'Milk 2L');
      assert.equal(all[0].store.retailer, 'paknsave');

      const history = await repo.productHistory('paknsave:p1');
      assert.equal(history.length, 1);
      assert.equal(history[0].product.name, 'Milk 2L');
    } finally {
      repo.close();
    }
  });

  it('never opens app.db path (two-DB rule)', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const archivePath = join(dir, 'archive.db');
    const appPath = join(dir, 'app.db');
    writeFileSync(appPath, 'not-a-real-db');
    const repo = new SqliteArchiveRepository(archivePath);
    try {
      await repo.append([obs()]);
      // If archive code opened app.db it would corrupt or throw on that file.
      const { readFileSync } = await import('node:fs');
      assert.equal(readFileSync(appPath, 'utf8'), 'not-a-real-db');
    } finally {
      repo.close();
    }
  });

  it('advertisedSpecials serves the materialized specials table after rebuild', async () => {
    const { repo } = open();
    try {
      const promotion = { type: 'SPECIAL', startsAt: '2026-07-01T00:00:00.000Z', endsAt: '2026-12-31T00:00:00.000Z' };
      await repo.append([
        obs({ productId: 'paknsave:p1', regularCents: 500, promoCents: 300, promotion }),
        obs({ productId: 'paknsave:p2', storeId: 'paknsave:s1', regularCents: 400, promoCents: 380, promotion }),
      ], { snapshotScope: 'specials' });

      // Before rebuild the specials table is empty → falls back to the live query.
      const live = repo.advertisedSpecials({ at: '2026-07-17T13:00:00.000Z' });
      assert.ok(live.length >= 1, 'live fallback returns specials');

      const materialized = repo.rebuildSpecials({ at: '2026-07-17T13:00:00.000Z' });
      assert.ok(materialized >= 2, `materialized top-N specials, got ${materialized}`);

      const served = repo.advertisedSpecials({ at: '2026-07-17T13:00:00.000Z' });
      // Biggest discount first (p1: 40% beats p2: 5%).
      assert.equal(served[0].productId, 'paknsave:p1');
      assert.equal(served[0].currentCents, 300);
      assert.equal(served[0].regularCents, 500);
      assert.ok(served[0].promotion, 'promotion carried through');
    } finally {
      repo.close();
    }
  });

  it('lapsed promotions drop out of the materialized feed at read time', async () => {
    const { repo } = open();
    try {
      await repo.append([
        obs({ productId: 'paknsave:p1', regularCents: 500, promoCents: 300,
          promotion: { type: 'SPECIAL', endsAt: '2026-07-15T00:00:00.000Z' } }),
      ], { snapshotScope: 'specials' });
      repo.rebuildSpecials({ at: '2026-07-17T13:00:00.000Z' });

      // Read after the promo has ended → filtered out even though materialized.
      const served = repo.advertisedSpecials({ at: '2026-07-20T00:00:00.000Z' });
      assert.equal(served.length, 0, 'expired promotion is re-checked at read time');
    } finally {
      repo.close();
    }
  });

  it('unfiltered productListings interleaves retailers newest-first', async () => {
    const { repo } = open();
    try {
      await repo.append([
        obs({ productId: 'paknsave:a', storeId: 'paknsave:s1', retailer: 'paknsave', observedAt: '2026-07-17T12:00:00.000Z' }),
        obs({ productId: 'paknsave:b', storeId: 'paknsave:s1', retailer: 'paknsave', observedAt: '2026-07-17T11:00:00.000Z' }),
        obs({ productId: 'woolworths:c', storeId: 'woolworths:s1', retailer: 'woolworths', observedAt: '2026-07-16T10:00:00.000Z' }),
      ], { snapshotScope: 'specials' });

      const page = repo.productListings({ limit: 10 });
      assert.equal(page.total, 3);
      // First two rows come from different retailers (round-robin, not one chain).
      assert.notEqual(page.products[0].retailer, page.products[1].retailer);
    } finally {
      repo.close();
    }
  });

  it('importJsonl streams v2 records without whole-file load', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const jsonl = join(dir, 'prices.jsonl');
    const lines = [
      JSON.stringify({
        version: 2, type: 'product', productId: 'nw:p1', hash: 'a'.repeat(64),
        observedAt: '2026-07-13T12:00:00.000Z',
        data: { id: 'nw:p1', name: 'Bread', brand: 'Tip Top', categories: ['Bakery'] },
      }),
      JSON.stringify({
        version: 2, type: 'store', storeId: 'nw:s1', hash: 'b'.repeat(64),
        observedAt: '2026-07-13T12:00:00.000Z',
        data: { id: 'nw:s1', retailer: 'newworld', name: 'Remuera' },
      }),
      JSON.stringify({
        version: 2, type: 'offer',
        offerId: 'nw:p1\u0000nw:s1', productId: 'nw:p1', storeId: 'nw:s1',
        hash: 'c'.repeat(64), observedAt: '2026-07-13T12:00:00.000Z',
        data: {
          price: { regularCents: 350 },
          source: { retailerProductId: 'p1', adapter: 'test', url: 'https://ex' },
        },
      }),
      JSON.stringify({
        version: 2, type: 'snapshot', scope: 'specials', storeId: 'nw:s1',
        observedAt: '2026-07-13T12:00:00.000Z', offerCount: 1, offersHash: 'd'.repeat(64),
        added: ['nw:p1\u0000nw:s1'], removed: [],
      }),
    ];
    writeFileSync(jsonl, lines.join('\n') + '\n');

    const repo = new SqliteArchiveRepository(join(dir, 'archive.db'));
    try {
      const result = await repo.importJsonl(jsonl, { strict: true });
      assert.equal(result.errors, 0);
      assert.ok(result.imported >= 4);
      const q = await repo.query({ retailer: 'newworld' });
      assert.equal(q.length, 1);
      assert.equal(q[0].price.regularCents, 350);
      assert.equal(q[0].isOnSpecial, true);
    } finally {
      repo.close();
    }
  });
});

describe('createObservationRepository', () => {
  it('selects SQLite for .db paths and JSONL otherwise', () => {
    const dir = tmpDir();
    const db = createObservationRepository(join(dir, 'a.db'));
    assert.ok(db instanceof SqliteArchiveRepository);
    db.close();
    const jsonl = createObservationRepository(join(dir, 'a.jsonl'));
    assert.ok(jsonl instanceof JsonlObservationRepository);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('ProjectionRepository from archive.db', () => {
  it('rebuilds prices.db from SqliteArchiveRepository source', async () => {
    const { ProjectionRepository } = await import('../../src/sqlite/projection-repository.js');
    const dir = tmpDir();
    const archivePath = join(dir, 'archive.db');
    const pricesPath = join(dir, 'prices.db');
    const archive = new SqliteArchiveRepository(archivePath);
    try {
      await archive.append([obs({ regularCents: 499 })], { snapshotScope: 'specials' });
      archive.close();

      const proj = new ProjectionRepository(archivePath, pricesPath);
      const result = proj.rebuild({ force: true });
      assert.equal(result.status, 'rebuilt');
      assert.ok(result.recordsImported >= 3);
      proj.open();
      const rows = proj.query({});
      assert.equal(rows.length, 1);
      assert.equal(rows[0].price.regularCents, 499);
      assert.equal(rows[0].product.name, 'Milk 2L');
      const kind = proj.db.prepare("SELECT value FROM _meta WHERE key = 'source_kind'").get();
      assert.equal(kind?.value, 'archive.db');
      proj.close();
    } finally {
      try { archive.close(); } catch { /* ok */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
