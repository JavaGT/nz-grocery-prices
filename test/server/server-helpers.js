import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ProjectionRepository } from '../../src/sqlite/projection-repository.js';
import { AppDatabase } from '../../src/sqlite/app-db.js';
import { Auth } from '../../src/app/auth.js';
import { Server } from '../../src/server/server.js';
import { createPublicHandlers, defaultQueryDbObservations } from '../../src/server/handlers/public.js';
import { createPrivateHandlers } from '../../src/server/handlers/private.js';

let _counter = 0;
export function hash(s) {
  _counter++;
  return String(_counter).padStart(64, '0');
}

export function tmpDir() {
  const d = mkdtempSync(join(tmpdir(), 'prices-srv-'));
  return {
    dir: d,
    jsonl: join(d, 'fixture.jsonl'),
    pricesDb: join(d, 'prices.db'),
    appDb: join(d, 'app.db'),
    cleanup() { try { rmSync(d, { recursive: true }) } catch {} },
  };
}

export function writeFixture(path, records) {
  writeFileSync(path, records.map(r => JSON.stringify(r)).join('\n') + '\n');
}

export function productRec(productId, overrides = {}) {
  return {
    version: 2, type: 'product',
    productId,
    hash: hash(productId),
    observedAt: overrides.observedAt || '2026-07-15T10:00:00.000Z',
    data: {
      name: 'Test Product', brand: 'Test Brand', categories: ['Groceries'],
      size: null, image_url: null, source_id: null, gtin: null,
      ...overrides.data, ...overrides,
    },
  };
}

export function storeRec(storeId, overrides = {}) {
  const [retailer] = storeId.split(':');
  return {
    version: 2, type: 'store',
    storeId,
    hash: hash(storeId),
    observedAt: overrides.observedAt || '2026-07-15T10:00:00.000Z',
    data: {
      id: storeId, name: 'Test Store', retailer,
      address: null, region: null, ...overrides.data,
    },
  };
}

export function offerRec(productId, storeId, priceData = {}, extra = {}) {
  const offerKey = `${productId}\x00${storeId}`;
  return {
    version: 2, type: 'offer',
    offerId: offerKey, productId, storeId,
    hash: hash(offerKey),
    observedAt: extra.observedAt || '2026-07-15T12:00:00.000Z',
    data: {
      price: { regularCents: 1000, promoCents: null, memberCents: null, ...priceData },
      source: { retailerProductId: productId.split(':').pop(), adapter: 'test', url: 'https://example.com/p', ...extra.source },
      ...(extra.promotion ? { promotion: extra.promotion } : {}),
    },
  };
}

function buildProjectionDb(pricesDb, jsonl, records, sql) {
  if (records.length > 0) {
    writeFixture(jsonl, records);
  } else {
    writeFileSync(jsonl, '\n');
  }
  const repo = new ProjectionRepository(jsonl, pricesDb);
  try { repo.rebuild({ force: true }); } catch (e) {
    repo.close();
    throw e;
  }
  repo.close();

  if (sql.length > 0) {
    const db = new DatabaseSync(pricesDb);
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA foreign_keys=ON');
    for (const stmt of sql) { db.exec(stmt); }
    db.close();
  }
}

export async function createTestServer({
  records = [],
  sql = [],
  appDbInit = null,
  authOptions = {},
  skipProjDb = false,
} = {}) {
  const dir = tmpDir();

  try {
    if (!skipProjDb) {
      buildProjectionDb(dir.pricesDb, dir.jsonl, records, sql);
    }

    let projDb = null;
    if (!skipProjDb) {
      try {
        projDb = new DatabaseSync(dir.pricesDb, { readOnly: true });
      } catch { projDb = null; }
    }

    let projDbRef = projDb;
    function getDb() { return projDbRef; }

    const appDb = new AppDatabase(dir.appDb);
    if (typeof appDbInit === 'function') {
      appDbInit(appDb);
    }
    const auth = new Auth(appDb, { sessionDurationMs: 86400000, ...authOptions });

    const server = new Server({ projDb, appDb, auth });
    const now = Date.now();
    const handlers = createPublicHandlers({ getDb, appDb, auth, clock: Date.now, startedAt: now, queryDbObservations: defaultQueryDbObservations });
    const privateHandlers = createPrivateHandlers({ auth, appDb, clock: Date.now });

    server.get('/api/health', handlers.health);
    server.get('/api/products', handlers.listProducts);
    server.get('/api/products/:productId', handlers.getProduct);
    server.get('/api/products/:productId/history', handlers.getProductHistory);
    server.get('/api/stores', handlers.listStores);
    server.get('/api/search/suggestions', handlers.searchSuggestions);
    server.get('/api/deals', handlers.listDeals);

    server.post('/api/auth/register', privateHandlers.register);
    server.post('/api/auth/login', privateHandlers.login);
    server.post('/api/auth/logout', privateHandlers.logout);
    server.get('/api/watch-list', privateHandlers.getWatchList);
    server.post('/api/watch-list', privateHandlers.addWatchList);
    server.delete('/api/watch-list/:entryId', privateHandlers.deleteWatchList);
    server.get('/api/preferred-stores', privateHandlers.getPreferredStores);
    server.post('/api/preferred-stores', privateHandlers.setPreferredStore);
    server.delete('/api/preferred-stores/:contextId', privateHandlers.deletePreferredStore);
    server.get('/api/saved-searches', privateHandlers.getSavedSearches);
    server.post('/api/saved-searches', privateHandlers.createSavedSearch);
    server.delete('/api/saved-searches/:searchId', privateHandlers.deleteSavedSearch);
    server.get('/api/new-products', privateHandlers.getNewProducts);

    const port = await server.start(0);

    return {
      server, port,
      baseUrl: `http://127.0.0.1:${port}`,
      appDb, auth, dir, projDb,
      setProjDb(db) { projDbRef = db; },
      async close() {
        await server.stop();
        try { projDb?.close(); } catch {}
        try { appDb.close(); } catch {}
        dir.cleanup();
      },
    };
  } catch (err) {
    dir.cleanup();
    throw err;
  }
}
