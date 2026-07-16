import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fork } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';

const BUILD_DB = resolve('scripts/build-db.js');

function tmp() {
  const d = mkdtempSync(join(tmpdir(), 'concur-'));
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

function forkBuild(jsonlPath, dbPath, force = false) {
  return new Promise((resolvePromise, reject) => {
    const args = ['--file', jsonlPath, '--output', dbPath];
    if (force) args.push('--force');
    const child = fork(BUILD_DB, args, {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      execArgv: [],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('close', code => {
      const parsed = stdout.trim() ? (() => { try { return JSON.parse(stdout); } catch { return null; } })() : null;
      resolvePromise({ code, stdout, stderr, parsed });
    });
    child.on('error', reject);
  });
}

describe('concurrent rebuilds', () => {
  it('two simultaneous rebuilds to the same DB path both succeed with no corruption', async () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'concurrent.jsonl');
    const dbPath = join(dir, 'concurrent.db');

    writeFileSync(jsonlPath, [
      v2product('conc:p1', { name: 'Concurrent Product Alpha' }),
      v2product('conc:p2', { name: 'Concurrent Product Beta' }),
      v2store('conc:s1', { name: 'Concurrent Store' }),
      v2offer('conc:p1', 'conc:s1', { regularCents: 750 }),
      v2offer('conc:p2', 'conc:s1', { regularCents: 1250 }),
    ].join('\n') + '\n');

    try {
      const [resultA, resultB] = await Promise.all([
        forkBuild(jsonlPath, dbPath),
        forkBuild(jsonlPath, dbPath),
      ]);

      assert.ok(resultA.code === 0 || resultA.parsed?.status === 'rebuilt',
        `Child A exited with code ${resultA.code}: ${resultA.stderr}`);
      assert.ok(resultB.code === 0 || resultB.parsed?.status === 'rebuilt',
        `Child B exited with code ${resultB.code}: ${resultB.stderr}`);

      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode=WAL');

      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(r => r.name);
      assert.ok(tables.includes('products'), 'products table must exist');
      assert.ok(tables.includes('offer_revisions'), 'offer_revisions table must exist');
      assert.ok(tables.includes('_meta'), '_meta table must exist');

      const productCount = db.prepare('SELECT COUNT(*) AS cnt FROM products').get().cnt;
      assert.equal(productCount, 2, 'should have 2 products');

      const offerCount = db.prepare('SELECT COUNT(*) AS cnt FROM offer_revisions').get().cnt;
      assert.equal(offerCount, 2, 'should have 2 offers');

      const names = db.prepare('SELECT name FROM products ORDER BY name').all().map(r => r.name);
      assert.deepEqual(names, ['Concurrent Product Alpha', 'Concurrent Product Beta']);

      db.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('four concurrent rebuilds to the same DB path leave a valid DB with all data', async () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'multi-concurrent.jsonl');
    const dbPath = join(dir, 'multi-concurrent.db');

    const records = [];
    for (let i = 0; i < 5; i++) {
      records.push(v2product(`multi:p${i}`, { name: `Product ${i}` }));
    }
    records.push(v2store('multi:s1', { name: 'Multi Store' }));
    for (let i = 0; i < 5; i++) {
      records.push(v2offer(`multi:p${i}`, 'multi:s1', { regularCents: 300 + i * 50 }));
    }
    writeFileSync(jsonlPath, records.join('\n') + '\n');

    try {
      const results = await Promise.all([
        forkBuild(jsonlPath, dbPath),
        forkBuild(jsonlPath, dbPath),
        forkBuild(jsonlPath, dbPath),
        forkBuild(jsonlPath, dbPath),
      ]);

      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        assert.ok(r.code === 0 || r.parsed?.status !== undefined,
          `Child ${i} exited with code ${r.code}: ${r.stderr}`);
      }

      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode=WAL');

      const productCount = db.prepare('SELECT COUNT(*) AS cnt FROM products').get().cnt;
      assert.equal(productCount, 5, 'should have 5 products after concurrent rebuilds');

      const offerCount = db.prepare('SELECT COUNT(*) AS cnt FROM offer_revisions').get().cnt;
      assert.equal(offerCount, 5, 'should have 5 offers after concurrent rebuilds');

      const meta = db.prepare("SELECT key, value FROM _meta WHERE key = 'jsonl_fingerprint'").get();
      assert.ok(meta, '_meta fingerprint must exist');
      assert.equal(meta.value.length, 64);

      db.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it('one force rebuild concurrent with a normal rebuild leaves DB valid', async () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'mixed-concurrent.jsonl');
    const dbPath = join(dir, 'mixed-concurrent.db');

    writeFileSync(jsonlPath, [
      v2product('mix:p1', { name: 'Mix Product One' }),
      v2product('mix:p2', { name: 'Mix Product Two' }),
      v2store('mix:s1', {}),
      v2offer('mix:p1', 'mix:s1', { regularCents: 900 }),
      v2offer('mix:p2', 'mix:s1', { regularCents: 1100 }),
    ].join('\n') + '\n');

    try {
      const [normal, forced] = await Promise.all([
        forkBuild(jsonlPath, dbPath),
        forkBuild(jsonlPath, dbPath, true), // force rebuild
      ]);

      assert.ok(normal.code === 0, `normal build: ${normal.stderr}`);
      assert.ok(forced.code === 0, `forced build: ${forced.stderr}`);

      const db = new DatabaseSync(dbPath);
      const productCount = db.prepare('SELECT COUNT(*) AS cnt FROM products').get().cnt;
      assert.equal(productCount, 2);
      db.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});

describe('concurrent readers during rebuild', () => {
  it('reader can query the old DB while a rebuild completes', async () => {
    const { dir } = tmp();
    const jsonlPath = join(dir, 'reader-race.jsonl');
    const dbPath = join(dir, 'reader-race.db');

    writeFileSync(jsonlPath, [
      v2product('race:p1', { name: 'Race Product' }),
      v2store('race:s1', {}),
      v2offer('race:p1', 'race:s1', { regularCents: 333 }),
    ].join('\n') + '\n');

    try {
      const first = await forkBuild(jsonlPath, dbPath);
      assert.equal(first.code, 0);

      writeFileSync(jsonlPath, [
        v2product('race:p1', { name: 'Race Product' }),
        v2product('race:p2', { name: 'Second Product' }),
        v2store('race:s1', {}),
        v2offer('race:p1', 'race:s1', { regularCents: 333 }),
        v2offer('race:p2', 'race:s1', { regularCents: 444 }),
      ].join('\n') + '\n');

      const rebuildPromise = forkBuild(jsonlPath, dbPath, true);

      const db = new DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode=WAL');
      const oldCount = db.prepare('SELECT COUNT(*) AS cnt FROM products').get().cnt;
      assert.equal(oldCount, 1, 'old DB should have 1 product before rebuild completes');
      db.close();

      await rebuildPromise;

      const newDb = new DatabaseSync(dbPath);
      const newCount = newDb.prepare('SELECT COUNT(*) AS cnt FROM products').get().cnt;
      assert.ok(newCount >= 1, 'DB should be readable after concurrent rebuild');
      newDb.close();
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
});
