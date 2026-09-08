#!/usr/bin/env node
// spa-lane in-process micro bench: attributes per-request costs that are too
// small to see over HTTP (statement prepare vs execute, session lookup,
// freshness snapshot, route matching, serialization). Read-only against
// /tmp/perf-spa fixtures; the app DB is copied to /tmp/perf-spa/app-micro.db
// so WAL sidecars never touch the seeded fixture.
//
// Usage: node perf-notes/bench-spa-micro.js [--iters 2000] [--json <out>]

import { copyFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { AppDatabase } from '../src/sqlite/app-db.js';
import { Auth } from '../src/app/auth.js';
import { createPublicHandlers } from '../src/server/handlers/public.js';
import { Server, parseAcceptEncoding } from '../src/server/server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (name, def) => {
  let i = args.indexOf(name);
  return i >= 0 ? args[++i] : def;
};
const ITERS = parseInt(argOf('--iters', '2000'), 10);
const JSON_OUT = argOf('--json', null);

const FIXTURES = '/tmp/perf-spa';
const APP_DB_COPY = join(FIXTURES, 'app-micro.db');
for (const f of ['app-micro.db', 'app-micro.db-wal', 'app-micro.db-shm']) {
  const p = join(FIXTURES, f);
  if (existsSync(p)) rmSync(p);
}
copyFileSync(join(FIXTURES, 'app.db'), APP_DB_COPY);

const projDb = new DatabaseSync(join(FIXTURES, 'prices.db'), { readOnly: true });
const appDb = new AppDatabase(APP_DB_COPY);
const auth = new Auth(appDb, { clock: () => Date.now() });

// A real session token from the seeder (sha256 of it exists in the fixture).
const TOKEN = process.env.BENCH_SID;
if (!TOKEN) { console.error('BENCH_SID env required (from seed-spa-fixtures.js)'); process.exit(1); }
const tokenHash = (t) => createHash('sha256').update(t).digest('hex');

const results = {};
function bench(name, fn, iters = ITERS) {
  // warmup
  for (let i = 0; i < Math.min(200, iters); i++) fn();
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  const ms = (performance.now() - t0) / iters;
  results[name] = +ms.toFixed(4);
  process.stdout.write(`${ms.toFixed(4).padStart(9)} ms/op  ${name}\n`);
}

// --- SQL cost attribution on the products-search path ---
const LIKE = `%${'butter'.replace(/[%_]/g, '\\$&')}%`;
bench('sql: count LIKE scan (search)', () => {
  projDb.prepare('SELECT COUNT(*) AS c FROM products WHERE name LIKE ? COLLATE NOCASE').get(LIKE);
});
bench('sql: page LIKE scan + order (search)', () => {
  projDb.prepare(`
    SELECT id, retailer_id, name, brand, category, image_url, size,
           source_id, gtin, first_seen_at, updated_at
    FROM products WHERE name LIKE ? COLLATE NOCASE
    ORDER BY CASE WHEN name = ? THEN 0 WHEN name LIKE ? THEN 1 ELSE 2 END, updated_at DESC
    LIMIT 42 OFFSET 0
  `).all(LIKE, 'butter', `%butter%`);
});
bench('sql: combined window-count page scan', () => {
  projDb.prepare(`
    SELECT id, retailer_id, name, brand, category, image_url, size,
           source_id, gtin, first_seen_at, updated_at,
           COUNT(*) OVER () AS _total
    FROM products WHERE name LIKE ? COLLATE NOCASE
    ORDER BY CASE WHEN name = ? THEN 0 WHEN name LIKE ? THEN 1 ELSE 2 END, updated_at DESC
    LIMIT 42 OFFSET 0
  `).all(LIKE, 'butter', `%butter%`);
});
{
  const stmt = projDb.prepare('SELECT COUNT(*) AS c FROM products WHERE name LIKE ? COLLATE NOCASE');
  bench('sql: same count with cached statement', () => stmt.get(LIKE));
}
bench('sql: prepare() alone (no execute)', () => {
  projDb.prepare('SELECT COUNT(*) AS c FROM products WHERE name LIKE ? COLLATE NOCASE');
});
bench('sql: _meta freshness read', () => {
  projDb.prepare('SELECT key, value FROM _meta').all();
});
{
  const stmt = projDb.prepare('SELECT key, value FROM _meta').all.bind ? null : null;
  bench('sql: session join lookup', () => {
    appDb.getSession(tokenHash(TOKEN));
  });
}

// --- statement reuse delta on getSession ---
{
  const cached = appDb.db.prepare(`
    SELECT s.id, s.user_id, s.expires_at, s.created_at, u.username
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?
  `);
  bench('sql: session lookup, cached statement', () => cached.get(tokenHash(TOKEN)) || null);
}
bench('auth: getSessionUser full (hash+lookup+expiry)', () => auth.getSessionUser(TOKEN));
bench('crypto: sha256 token hash', () => tokenHash(TOKEN));

// --- per-request server overheads ---
bench('url: new URL per request', () => new URL('/api/products?query=butter&limit=42', 'http://127.0.0.1:3010'));
bench('aenc: parseAcceptEncoding', () => parseAcceptEncoding('gzip, deflate, br'));
{
  const rows = projDb.prepare('SELECT key, value FROM _meta').all();
  bench('json: Object.fromEntries meta rows', () => Object.fromEntries(rows.map(r => [r.key, r.value])));
}
{
  const payload = { products: Array.from({ length: 42 }, (_, i) => ({
    id: `paknsave:${i}`, retailerId: 'paknsave', retailerName: "PAK'nSAVE", name: `Product ${i}`,
    brand: 'Brand', category: 'cat', imageUrl: null, size: '750g', sourceId: 's', gtin: null,
    firstSeenAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-08T00:00:00.000Z',
  })), total: 137, limit: 42, offset: 0 };
  bench('json: stringify 42-product payload', () => JSON.stringify(payload));
}

// --- route matching cost (20 routes, current double-pass) ---
{
  const routes = [
    ['GET', /^\/api\/health$/], ['GET', /^\/api\/products$/], ['GET', /^\/api\/products\/([^/]+)$/],
    ['GET', /^\/api\/products\/([^/]+)\/history$/], ['GET', /^\/api\/stores$/],
    ['GET', /^\/api\/search\/suggestions$/], ['GET', /^\/api\/deals$/],
    ['POST', /^\/api\/auth\/register$/], ['POST', /^\/api\/auth\/login$/], ['POST', /^\/api\/auth\/logout$/],
    ['GET', /^\/api\/watch-list$/], ['POST', /^\/api\/watch-list$/], ['DELETE', /^\/api\/watch-list\/([^/]+)$/],
    ['GET', /^\/api\/preferred-stores$/], ['POST', /^\/api\/preferred-stores$/],
    ['DELETE', /^\/api\/preferred-stores\/([^/]+)$/], ['GET', /^\/api\/saved-searches$/],
    ['POST', /^\/api\/saved-searches$/], ['DELETE', /^\/api\/saved-searches\/([^/]+)$/],
    ['GET', /^\/api\/new-products$/],
  ];
  const pathname = '/api/products/paknsave:283248';
  bench('routes: current double-pass (allowed set + match)', () => {
    const allowed = new Set(routes.filter(r => r[1].test(pathname)).map(r => r[0]));
    if (allowed.size > 0 && !allowed.has('GET')) throw new Error('405');
    let matched = null;
    for (const [method, re] of routes) {
      if (method !== 'GET') continue;
      const m = re.exec(pathname);
      if (m) { matched = m; break; }
    }
    if (!matched) throw new Error('404');
  });
  bench('routes: single-pass match', () => {
    let pathMatched = false;
    let matched = null;
    for (const [method, re] of routes) {
      if (!re.test(pathname)) continue;
      if (method === 'GET') { matched = re.exec(pathname); break; }
      pathMatched = true;
    }
    if (!matched && pathMatched) throw new Error('405');
    if (!matched) throw new Error('404');
  });
}

// --- authenticated deals tiering reads ---
{
  const ctx = {
    query: {}, params: {}, requestId: 'x', projection: projDb, appDb, auth,
    clock: Date.now, cookies: { sid: TOKEN }, headers: {}, req: { socket: {} },
  };
  bench('tiers: loadUserTiers reads (watch+prefs+IN query)', () => {
    // Mirror of the handler's loadUserTiers SQL work only.
    const watchEntries = appDb.getWatchList(1);
    const prefRows = appDb.getStorePreferences(1);
    if (prefRows.length > 0) {
      const contextIds = prefRows.map(r => r.context_id);
      const placeholders = contextIds.map(() => '?').join(',');
      projDb.prepare(`SELECT store_id FROM price_contexts WHERE id IN (${placeholders})`).all(...contextIds);
    }
    return watchEntries.length;
  });
  {
    const wStmt = appDb.db.prepare('SELECT * FROM watch_list_entries WHERE user_id = ? ORDER BY created_at DESC');
    const pStmt = appDb.db.prepare('SELECT * FROM user_store_preferences WHERE user_id = ? ORDER BY rank ASC');
    const iStmt = projDb.prepare('SELECT store_id FROM price_contexts WHERE id IN (?,?)');
    bench('tiers: same reads, cached statements', () => {
      const watchEntries = wStmt.all(1);
      const prefRows = pStmt.all(1);
      if (prefRows.length > 0) {
        const contextIds = prefRows.map(r => r.context_id);
        const placeholders = contextIds.map(() => '?').join(',');
        projDb.prepare(`SELECT store_id FROM price_contexts WHERE id IN (${placeholders})`).all(...contextIds);
      }
      return watchEntries.length;
    });
  }
}

if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
  process.stdout.write(`json written to ${JSON_OUT}\n`);
}
projDb.close();
appDb.close();
