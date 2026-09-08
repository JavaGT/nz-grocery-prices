#!/usr/bin/env node
// Behavior-parity sweep for the windowed-COUNT listProducts change: runs the
// live handler against the real fixture projection DB and compares its
// response to the pre-change two-query formulation (COUNT + page) executed
// directly on the same DB, for a sweep of queries (plain, wildcard-bearing,
// retailer combos, pagination incl. pages past the end).
//
// Read-only against /tmp/perf-spa/prices.db.
// Usage: node perf-notes/parity-products-search.js

import { DatabaseSync } from 'node:sqlite';
import { createPublicHandlers } from '../src/server/handlers/public.js';

const db = new DatabaseSync('/tmp/perf-spa/prices.db', { readOnly: true });
const handlers = createPublicHandlers({
  getDb: db,
  appDb: undefined,
  auth: undefined,
  clock: () => Date.now(),
  startedAt: Date.now(),
});

// The pre-change formulation, verbatim.
function oldListProducts({ query = {}, params: _ = {} }) {
  const clamp = (v, min, max, def) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : def;
  };
  const q = (query.query || '').trim();
  const retailer = (query.retailer || '').trim();
  const limit = clamp(query.limit, 1, 200, 42);
  const offset = clamp(query.offset, 0, Infinity, 0);
  const params = [];
  const where = [];
  if (q) {
    where.push('name LIKE ? COLLATE NOCASE');
    params.push(`%${q.replace(/[%_]/g, '\\$&')}%`);
  }
  if (retailer) {
    where.push('retailer_id = ?');
    params.push(retailer);
  }
  const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
  const orderClause = q
    ? 'ORDER BY CASE WHEN name = ? THEN 0 WHEN name LIKE ? THEN 1 ELSE 2 END, updated_at DESC'
    : 'ORDER BY updated_at DESC';
  const countRow = db.prepare(`SELECT COUNT(*) AS c FROM products ${whereClause}`).get(...params);
  const total = countRow ? countRow.c : 0;
  const orderParams = q ? [q, `%${q}%`] : [];
  const rows = db.prepare(`
    SELECT id, retailer_id, name, brand, category, image_url, size,
           source_id, gtin, first_seen_at, updated_at
    FROM products ${whereClause} ${orderClause} LIMIT ? OFFSET ?
  `).all(...params, ...orderParams, limit, offset);
  const RETAILER_DISPLAY = {
    paknsave: "PAK'nSAVE",
    newworld: 'New World',
    woolworths: 'Woolworths',
    freshchoice: 'FreshChoice',
    warehouse: 'The Warehouse',
  };
  const retailerName = id => RETAILER_DISPLAY[id] || id;
  const fmt = r => ({
    id: r.id, retailerId: r.retailer_id, retailerName: retailerName(r.retailer_id), name: r.name,
    brand: r.brand || null, category: r.category || null, imageUrl: r.image_url || null,
    size: r.size || null, sourceId: r.source_id || null, gtin: r.gtin || null,
    firstSeenAt: r.first_seen_at ? new Date(r.first_seen_at).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  });
  return { products: rows.map(fmt), total, limit, offset };
}

const queries = [
  {}, { query: 'butter' }, { query: 'milk' }, { query: 'chicken' },
  { query: 'the' }, { query: 'zzz-none' }, { query: '100%' }, { query: 'under_score' },
  { query: 'back\\slash' }, { query: 'a' }, { query: 'MILK' },
  { retailer: 'paknsave' }, { retailer: 'newworld' }, { retailer: 'nosuch' },
  { query: 'milk', retailer: 'paknsave' }, { query: 'milk', retailer: 'woolworths' },
  { query: 'butter', limit: '10' }, { query: 'butter', limit: '10', offset: '5' },
  { query: 'butter', limit: '3', offset: '160' },
  { query: 'milk', limit: '2', offset: '5000' },
  { limit: '5', offset: '8000' }, { limit: '200' }, { query: 'e', limit: '200' },
];

let failures = 0;
for (const q of queries) {
  const live = await handlers.listProducts({ query: q, params: {}, clock: () => Date.now() });
  const ref = oldListProducts({ query: q });
  const same = JSON.stringify(live) === JSON.stringify(ref);
  if (!same) {
    failures++;
    console.log('MISMATCH', JSON.stringify(q));
    console.log('  live total', live.total, 'ref total', ref.total);
    console.log('  live[0]', live.products[0]?.id, 'ref[0]', ref.products[0]?.id);
    if (live.products.length !== ref.products.length) {
      console.log('  lengths', live.products.length, ref.products.length);
    } else {
      for (let i = 0; i < live.products.length; i++) {
        if (JSON.stringify(live.products[i]) !== JSON.stringify(ref.products[i])) {
          console.log('  first row diff at', i, live.products[i].id, 'vs', ref.products[i].id);
          break;
        }
      }
    }
  } else {
    console.log('ok  ', JSON.stringify(q).padEnd(46), `total=${live.total} rows=${live.products.length}`);
  }
}
console.log(failures === 0 ? '\nPARITY: all queries identical' : `\nFAILED: ${failures} mismatches`);
process.exit(failures === 0 ? 0 : 1);
