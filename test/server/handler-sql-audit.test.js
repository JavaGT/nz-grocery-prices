import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createPublicHandlers, defaultQueryDealSignals } from '../../src/server/handlers/public.js';

// Column audit: the handlers above are hot paths whose SELECT lists were
// trimmed of columns their mappings never read (rev_hash, offer_key,
// context_id in the deals window; source_data/promotion_data on product
// detail; source_data in history; latest_hash via SELECT * on listings).
// These tests pin the SQL so the dead column reads cannot creep back — the
// columns themselves stay in the schema (the rebuild writes them).

function selectList(sql) {
  const upper = sql.toUpperCase();
  const from = upper.indexOf(' FROM ');
  assert.ok(from > 0, `SQL has a FROM clause: ${sql}`);
  return sql.slice(0, from);
}

function recordingDb({ row = null, rows = [] }) {
  const sqls = [];
  return {
    sqls,
    prepare(sql) {
      sqls.push(sql);
      return {
        get: () => row,
        all: () => rows,
      };
    },
  };
}

const NOW = Date.parse('2026-09-06T00:00:00.000Z');

describe('hot-path SELECT column audit', () => {
  it('signal loader reads deal_signals + joins and carries the retailer filter', () => {
    const db = recordingDb({ rows: [] });
    defaultQueryDealSignals(db, 'paknsave');
    assert.equal(db.sqls.length, 1);
    const sql = db.sqls[0];
    assert.ok(sql.includes('FROM deal_signals'), 'queries the materialized signals');
    assert.ok(sql.includes('WHERE pc.retailer_id = ?'), 'retailer filter is pushed into SQL');
    for (const needed of ['signal_kind', 'reference_cents', 'current_cents', 'drop_percent', 'calculated_at', 'price_policy']) {
      assert.ok(sql.includes(needed), `signal SELECT keeps ${needed}: ${sql}`);
    }
    const dbNoFilter = recordingDb({ rows: [] });
    defaultQueryDealSignals(dbNoFilter, undefined);
    assert.equal(dbNoFilter.sqls[0].includes('WHERE'), false, 'no retailer param -> no WHERE clause');
  });

  it('signal loader never reads build-only metadata columns', () => {
    const db = recordingDb({ rows: [] });
    defaultQueryDealSignals(db, undefined);
    const selected = selectList(db.sqls[0]);
    for (const dead of ['calc_version', 'baseline_window_days', 'min_samples', 'context_id']) {
      assert.equal(selected.includes(dead), false,
        `signal SELECT must not read build-only ${dead}: ${selected}`);
    }
  });

  it('product detail offers query does not read promotion_data or source_data', async () => {
    const offerRow = {
      offer_key: 'k', context_id: 7, price_regular_cents: 599,
      price_promo_cents: null, price_member_cents: null,
      comparative: null, observed_at: NOW,
      store_id: 'paknsave:001', store_name: 'Royal Oak', scope_kind: 'physical-store',
      retailer_id: 'paknsave', retailer_name: "PAK'nSAVE",
    };
    const productRow = {
      id: 'paknsave:milk', retailer_id: 'paknsave', name: 'Milk 1L', brand: 'Pams',
      category: 'Dairy', image_url: null, size: '1L', source_id: null, gtin: null,
      first_seen_at: NOW, updated_at: NOW,
    };
    const db = recordingDb({ row: productRow, rows: [offerRow] });
    const handlers = createPublicHandlers({ getDb: db, appDb: undefined, auth: undefined, clock: () => NOW, startedAt: NOW });
    const res = await handlers.getProduct({ params: { productId: 'paknsave:milk' }, query: {}, clock: () => NOW });
    const offersSql = db.sqls.find(s => s.includes('FROM offer_revisions or2'));
    assert.ok(offersSql, 'product detail queries offer_revisions');
    const selected = selectList(offersSql);
    for (const dead of ['promotion_data', 'source_data']) {
      assert.equal(selected.includes(dead), false, `offer SELECT must not read ${dead}: ${selected}`);
    }
    // The response contract survives the trim: every mapped field still present.
    assert.deepEqual(Object.keys(res.offers[0]).sort(),
      ['cents', 'comparative', 'historyUrl', 'isOnSpecial', 'lastSeenAt', 'offerKey', 'priceContext']);
    assert.deepEqual(Object.keys(res.offers[0].priceContext).sort(),
      ['retailerId', 'retailerName', 'scopeKind', 'storeId', 'storeName']);
    assert.deepEqual(Object.keys(res.offers[0].cents).sort(), ['member', 'promo', 'regular']);
    assert.equal(res.offers[0].offerKey, 'k');
    assert.equal(res.offers[0].priceContext.storeId, 'paknsave:001');
    assert.equal(res.offers[0].historyUrl, '/api/products/paknsave:milk/history?context=7');
  });

  it('history query does not read source_data', async () => {
    const historyRow = {
      offer_key: 'k', context_id: 7, product_id: 'paknsave:milk',
      price_regular_cents: 599, price_promo_cents: null, price_member_cents: null,
      comparative: null, promotion_data: null, observed_at: NOW,
    };
    const productRow = {
      id: 'paknsave:milk', retailer_id: 'paknsave', name: 'Milk 1L', brand: null,
      category: null, image_url: null, size: null, source_id: null, gtin: null,
      first_seen_at: NOW, updated_at: NOW,
    };
    const db = recordingDb({ row: productRow, rows: [historyRow] });
    const handlers = createPublicHandlers({ getDb: db, appDb: undefined, auth: undefined, clock: () => NOW, startedAt: NOW });
    const res = await handlers.getProductHistory({ params: { productId: 'paknsave:milk' }, query: {}, clock: () => NOW });
    const historySql = db.sqls.find(s => s.includes('FROM offer_revisions') && s.includes('LIMIT 200'));
    assert.ok(historySql, 'history queries offer_revisions');
    assert.equal(selectList(historySql).includes('source_data'), false,
      'history SELECT must not read source_data');
    assert.deepEqual(Object.keys(res.history[0]).sort(),
      ['cents', 'comparative', 'contextId', 'observedAt', 'offerKey', 'promotion']);
    assert.equal(res.history[0].contextId, 7);
  });

  it('products listing selects explicit columns and never drags latest_hash', async () => {
    const db = recordingDb({ row: { c: 0 }, rows: [] });
    const handlers = createPublicHandlers({ getDb: db, appDb: undefined, auth: undefined, clock: () => NOW, startedAt: NOW });
    await handlers.listProducts({ query: {}, params: {}, clock: () => NOW });
    const listingSql = db.sqls.find(s => s.includes('LIMIT ? OFFSET ?'));
    assert.ok(listingSql, 'listing query present');
    assert.equal(/SELECT\s+\*/.test(listingSql), false, 'no SELECT * on the products listing');
    const selected = selectList(listingSql);
    for (const needed of ['id', 'retailer_id', 'name', 'brand', 'category', 'image_url', 'size', 'source_id', 'gtin', 'first_seen_at', 'updated_at']) {
      assert.ok(selected.includes(needed), `listing SELECT keeps ${needed}: ${selected}`);
    }
    assert.equal(selected.includes('latest_hash'), false,
      'latest_hash is never formatted into a product response');
  });
});
