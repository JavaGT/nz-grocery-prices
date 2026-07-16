import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
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

  it('handles structurally valid JSON — bare object is error, unknown type is silently imported', () => {
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
      r.open();
      const meta = r.db.prepare("SELECT value FROM _meta WHERE key = 'error_count'").get();
      assert.equal(meta.value, '1', 'bare object is error; unknown-type v2 record counts as imported (defect: type dispatch has no default case)');
      r.close();
    } finally { rmSync(dir, { recursive: true }); }
  });

  it('handles legacy-format records (pre-v2) as imports', () => {
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
      const result = r.rebuild();
      assert.equal(result.status, 'rebuilt');
      r.open();
      const meta = r.db.prepare("SELECT value FROM _meta WHERE key = 'records_imported'").get();
      assert.equal(meta.value, '3', 'legacy record should be counted as imported');
      r.close();
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
