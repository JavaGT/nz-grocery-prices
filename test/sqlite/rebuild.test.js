import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  readFileSync,
  existsSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ProjectionRepository } from '../../src/sqlite/projection-repository.js';

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'rebuild-'));
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
      ...(extra.promotion ? { promotion: extra.promotion } : {}),
    },
  });
}

describe('deterministic fingerprint skip', () => {
  it('rebuild with unchanged JSONL returns status "skipped" on second call', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'fp.jsonl');
    const dbPath = join(dir, 'fp.db');
    writeFileSync(jsonlPath, [
      v2product('r:p1'),
      v2store('r:s1'),
      v2offer('r:p1', 'r:s1'),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      const first = r.rebuild();
      assert.equal(first.status, 'rebuilt');
      assert.equal(first.recordsImported, 3);

      const second = r.rebuild();
      assert.equal(second.status, 'skipped');
      assert.equal(second.fingerprint, first.fingerprint);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('rebuild with unchanged JSONL skips fingerprint check when force=true', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'fp2.jsonl');
    const dbPath = join(dir, 'fp2.db');
    writeFileSync(jsonlPath, [
      v2product('r:p1'),
      v2store('r:s1'),
      v2offer('r:p1', 'r:s1'),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      const forced = r.rebuild({ force: true });
      assert.equal(forced.status, 'rebuilt', 'force should bypass fingerprint check');
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('rebuild with changed JSONL triggers rebuild (different fingerprint)', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'changed.jsonl');
    const dbPath = join(dir, 'changed.db');
    writeFileSync(jsonlPath, v2product('r:p1') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      const first = r.rebuild();
      assert.equal(first.status, 'rebuilt');

      writeFileSync(jsonlPath, v2product('r:p2') + '\n');
      const second = r.rebuild();
      assert.equal(second.status, 'rebuilt', 'changed file content should trigger rebuild');
      assert.notEqual(second.fingerprint, first.fingerprint);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('rebuild stays skipped after re-opening DB with same JSONL', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'reopen.jsonl');
    const dbPath = join(dir, 'reopen.db');
    writeFileSync(jsonlPath, v2product('r:p1') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      const first = r.rebuild();
      assert.equal(first.status, 'rebuilt');

      const r2 = new ProjectionRepository(jsonlPath, dbPath);
      const second = r2.rebuild();
      assert.equal(second.status, 'skipped', 'new instance with same JSONL + DB should skip');
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('fingerprint stored in _meta matches rebuild result', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'fpmeta.jsonl');
    const dbPath = join(dir, 'fpmeta.db');
    writeFileSync(jsonlPath, v2product('r:p1') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      const result = r.rebuild();
      r.open();
      const meta = r.db.prepare("SELECT value FROM _meta WHERE key = 'jsonl_fingerprint'").get();
      assert.equal(meta.value, result.fingerprint);
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });
});

describe('force rebuild', () => {
  it('force: true rebuilds even when fingerprint matches', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'force.jsonl');
    const dbPath = join(dir, 'force.db');
    writeFileSync(jsonlPath, v2product('r:p1') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      const first = r.rebuild();
      const second = r.rebuild({ force: true });
      assert.equal(second.status, 'rebuilt');
      assert.equal(second.fingerprint, first.fingerprint);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('force rebuild updates built_at timestamp', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'forcetime.jsonl');
    const dbPath = join(dir, 'forcetime.db');
    writeFileSync(jsonlPath, v2product('r:p1') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      r.rebuild();
      r.open();
      const firstBuilt = r.db.prepare("SELECT value FROM _meta WHERE key = 'built_at'").get().value;
      r.close();

      r.rebuild({ force: true });
      r.open();
      const secondBuilt = r.db.prepare("SELECT value FROM _meta WHERE key = 'built_at'").get().value;
      assert.notEqual(firstBuilt, secondBuilt);
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });
});

describe('malformed line handling', () => {
  it('skips malformed JSON lines and increments error count', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'malformed.jsonl');
    const dbPath = join(dir, 'malformed.db');
    writeFileSync(jsonlPath, [
      v2product('r:p1'),
      'this is not json',
      v2offer('r:p1', 'r:s1'),
      v2store('r:s1'),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      const result = r.rebuild();
      assert.equal(result.status, 'rebuilt');
      assert.equal(result.errors, 1);

      r.open();
      const meta = r.db.prepare("SELECT value FROM _meta WHERE key = 'error_count'").get();
      assert.equal(meta.value, '1');
      const lastErrors = r.db.prepare("SELECT value FROM _meta WHERE key = 'last_errors'").get();
      assert.ok(lastErrors.value.includes('Line 2'));
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('records multiple malformed lines and accumulates errors', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'multimal.jsonl');
    const dbPath = join(dir, 'multimal.db');
    writeFileSync(jsonlPath, [
      'bad json 1',
      v2product('r:p1'),
      'bad json 2',
      v2store('r:s1'),
      'bad json 3',
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      const result = r.rebuild();
      assert.equal(result.status, 'rebuilt');
      assert.equal(result.errors, 3);

      r.open();
      const meta = r.db.prepare("SELECT value FROM _meta WHERE key = 'error_count'").get();
      assert.equal(meta.value, '3');
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('unknown-type v2 envelope is an ERROR, not a silent import (CORE-6 canonical parsing)', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'struct.jsonl');
    const dbPath = join(dir, 'struct.db');
    writeFileSync(jsonlPath, [
      v2product('r:p1'),
      JSON.stringify({ hello: 'world' }),
      v2store('r:s1'),
      JSON.stringify({ version: 2, type: 'unknown' }),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      const result = r.rebuild();
      assert.equal(result.status, 'rebuilt');
      assert.equal(result.errors, 2, 'bare object AND unknown type both error');
      r.open();
      const meta = r.db.prepare("SELECT value FROM _meta WHERE key = 'error_count'").get();
      assert.equal(meta.value, '2', 'nothing unrecognized is counted as imported');
      const lastErrors = r.db.prepare("SELECT value FROM _meta WHERE key = 'last_errors'").get();
      assert.match(lastErrors.value, /Line 4/, 'line numbers preserved for unknown types');
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('rejects legacy v1 records with an actionable migration error (CORE-6)', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'legacy.jsonl');
    const dbPath = join(dir, 'legacy.db');
    writeFileSync(jsonlPath, [
      v2product('r:p1'),
      v2store('r:s1'),
      JSON.stringify({
        product: { id: 'r:p2', name: 'Legacy Item', categories: [] },
        store: { id: 'r:s1', retailer: 'r', name: 'S' },
        price: { regularCents: 999 },
        source: { retailerProductId: 'x', adapter: 'legacy' },
        observedAt: '2026-07-13T12:00:00.000Z',
      }),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      // v1 is detected by SHAPE (unversioned product/store/price/source), so
      // the rebuild refuses BEFORE publishing a projection that silently
      // dropped the legacy fact.
      assert.throws(() => r.rebuild(), /migrate-v1-archive\.js --file/);
      // The refusal happens before the temp DB is published: no db file.
      assert.equal(existsSync(dbPath), false, 'no DB published for a v1-tainted archive');
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('projects valid mixed-order records without dropping early offers', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'mixed-order.jsonl');
    const dbPath = join(dir, 'mixed-order.db');
    writeFileSync(jsonlPath, [
      v2offer('r:p1', 'r:s1'),
      v2product('r:p1'),
      v2store('r:s1'),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      const result = r.rebuild();
      assert.equal(result.recordsImported, 3);
      r.open();
      assert.equal(r.query({}).length, 1, 'offer before its context remains queryable');
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('refuses an offer whose store context is absent instead of dropping it', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'missing-context.jsonl');
    const dbPath = join(dir, 'missing-context.db');
    writeFileSync(jsonlPath, [
      v2product('r:p1'),
      v2offer('r:p1', 'r:missing'),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      assert.throws(() => r.rebuild(), /no store revision/);
      assert.equal(existsSync(dbPath), false, 'lossy projection is never published');
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('refuses offers with missing products and snapshots with orphan offer IDs', () => {
    const { dir } = tmp();
    const missingProductPath = join(dir, 'missing-product.jsonl');
    const missingProductDb = join(dir, 'missing-product.db');
    writeFileSync(missingProductPath, [
      v2store('r:s1'),
      v2offer('r:missing', 'r:s1'),
    ].join('\n') + '\n');

    const orphanSnapshotPath = join(dir, 'orphan-snapshot.jsonl');
    const orphanSnapshotDb = join(dir, 'orphan-snapshot.db');
    writeFileSync(orphanSnapshotPath, [
      v2store('r:s1'),
      JSON.stringify({
        version: 2,
        type: 'snapshot',
        scope: 'specials',
        storeId: 'r:s1',
        observedAt: '2026-07-13T12:00:00.000Z',
        offersHash: 'h'.repeat(64),
        offerCount: 1,
        added: ['r:p1\x00r:s1'],
        removed: [],
      }),
    ].join('\n') + '\n');

    try {
      assert.throws(
        () => new ProjectionRepository(missingProductPath, missingProductDb).rebuild(),
        /has no product revision/,
      );
      assert.throws(
        () => new ProjectionRepository(orphanSnapshotPath, orphanSnapshotDb).rebuild(),
        /has no offer revision/,
      );
      assert.equal(existsSync(missingProductDb), false);
      assert.equal(existsSync(orphanSnapshotDb), false);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('rejects a mixed v1/v2 archive even though v2 records exist', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'mixed.jsonl');
    const dbPath = join(dir, 'mixed.db');
    writeFileSync(jsonlPath, [
      v2product('r:p1'),
      v2store('r:s1'),
      v2offer('r:p1', 'r:s1'),
      JSON.stringify({
        product: { id: 'r:p2', name: 'Legacy Item', categories: [] },
        store: { id: 'r:s1', retailer: 'r', name: 'S' },
        price: { regularCents: 999 },
        source: { retailerProductId: 'x', adapter: 'legacy' },
        observedAt: '2026-07-14T12:00:00.000Z',
      }),
    ].join('\n') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      assert.throws(
        () => r.rebuild(),
        (err) => /migrate-v1-archive\.js/.test(err.message) && /refused/i.test(err.message),
      );
      assert.equal(existsSync(dbPath), false);
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('a v1-only archive fails the zero-valid-records check with the migration pointer', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'v1only.jsonl');
    const dbPath = join(dir, 'v1only.db');
    writeFileSync(jsonlPath, JSON.stringify({
      product: { id: 'r:p2', name: 'Legacy Item', categories: [] },
      store: { id: 'r:s1', retailer: 'r', name: 'S' },
      price: { regularCents: 999 },
      source: { retailerProductId: 'x', adapter: 'legacy' },
      observedAt: '2026-07-13T12:00:00.000Z',
    }) + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      assert.throws(() => r.rebuild(), /migrate-v1-archive\.js/);
      assert.equal(existsSync(dbPath), false);
    } finally { rmSync(dir, { recursive: true }); }
  });
});

describe('missing archive', () => {
  it('rebuild throws ENOENT when JSONL file does not exist', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'nonexistent.jsonl');
    const dbPath = join(dir, 'nope.db');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      assert.throws(() => r.rebuild(), {
        code: 'ENOENT',
        message: /not found/,
      });
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('no DB file is created when rebuild fails with missing archive', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'missing.jsonl');
    const dbPath = join(dir, 'should-not-exist.db');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      assert.throws(() => r.rebuild());
      assert.equal(existsSync(dbPath), false, 'db file should not be created');
    } finally { rmSync(dir, { recursive: true }); }
  });
});

describe('rebuild locking (CORE-6)', () => {
  it('refuses to run while another rebuild holds the lock; no rename, no lock removal', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'locked.jsonl');
    const dbPath = join(dir, 'locked.db');
    writeFileSync(jsonlPath, v2product('r:p1') + '\n');
    try {
      mkdirSync(dbPath + '.lock'); // simulate a concurrent rebuild holding the lock
      const r = new ProjectionRepository(jsonlPath, dbPath);
      assert.throws(() => r.rebuild(), /locked by another writer/);
      // Nothing published, nothing stolen:
      assert.equal(existsSync(dbPath), false, 'no rename happened');
      assert.equal(readdirSync(dir).some(e => e.endsWith('.tmp-')), false, 'no temp artifacts');
      // The OTHER writer's lock must still be present.
      assert.equal(existsSync(dbPath + '.lock'), true, "another writer's lock untouched");
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('releases its own lock after a successful rebuild', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'unlock.jsonl');
    const dbPath = join(dir, 'unlock.db');
    writeFileSync(jsonlPath, v2product('r:p1') + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      const result = r.rebuild();
      assert.equal(result.status, 'rebuilt');
      assert.equal(existsSync(dbPath), true);
      assert.equal(existsSync(dbPath + '.lock'), false, 'own lock released');
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('releases its own lock after a failed rebuild (v1 refusal)', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'lockfail.jsonl');
    const dbPath = join(dir, 'lockfail.db');
    writeFileSync(jsonlPath, JSON.stringify({
      product: { id: 'r:p2', name: 'Legacy Item', categories: [] },
      store: { id: 'r:s1', retailer: 'r', name: 'S' },
      price: { regularCents: 999 },
      source: { retailerProductId: 'x', adapter: 'legacy' },
      observedAt: '2026-07-13T12:00:00.000Z',
    }) + '\n');
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      assert.throws(() => r.rebuild(), /migrate-v1-archive/);
      assert.equal(existsSync(dbPath + '.lock'), false, 'own lock released on failure');
    } finally { rmSync(dir, { recursive: true }); }
  });
});

describe('two-DB guard (CORE-6)', () => {
  it('refuses data/app.db as the output path without opening it', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'g.jsonl');
    writeFileSync(jsonlPath, v2product('r:p1') + '\n');
    const dbPath = join(dir, 'data', 'app.db');
    mkdirSync(join(dir, 'data'), { recursive: true });
    try {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      assert.throws(() => r.rebuild(), /application DB.*two-DB rule/s);
      assert.equal(existsSync(dbPath), false, 'app.db was never created/opened');
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('refuses APP_DB-configured paths and any path ending app.db (case-insensitive)', () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'g2.jsonl');
    writeFileSync(jsonlPath, v2product('r:p1') + '\n');
    const cases = [
      join(dir, 'weird-name-app.db'),
      join(dir, 'APP.DB'),
      join(dir, 'sub', 'dir', 'app.Db'),
    ];
    for (const dbPath of cases) {
      const r = new ProjectionRepository(jsonlPath, dbPath);
      assert.throws(() => r.rebuild(), /application DB/, `refused ${dbPath}`);
      assert.equal(existsSync(dbPath), false);
    }
    // The configured APP_DB path is refused even under another name.
    process.env.APP_DB = join(dir, 'configured', 'mydata.db');
    try {
      const r = new ProjectionRepository(jsonlPath, process.env.APP_DB);
      assert.throws(() => r.rebuild(), /application DB/);
    } finally {
      delete process.env.APP_DB;
      rmSync(dir, { recursive: true });
    }
  });
});
