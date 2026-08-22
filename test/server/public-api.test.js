import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, productRec, storeRec, offerRec, daysAgo } from './server-helpers.js';

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const body = await res.json();
  return { status: res.status, headers: res.headers, body };
}

describe('public API server', () => {
  describe('GET /api/health', () => {
    it('returns ok with projection metadata when DB exists', async () => {
      const srv = await createTestServer({
        records: [productRec('paknsave:milk', { data: { name: 'Milk' } })],
      });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/health`);
        assert.equal(status, 200);
        assert.equal(body.status, 'ok');
        assert.ok(body._requestId);
        assert.ok(body._freshness.exists);
        assert.ok(body._freshness.fingerprint);
        assert.equal(typeof body.uptime, 'number');
        assert.ok(body.startedAt);
        assert.ok(body.projection.exists);
        assert.ok(body.projection.fingerprint);
      } finally {
        await srv.close();
      }
    });

    it('returns degraded when projection DB missing', async () => {
      const srv = await createTestServer({ records: [], skipProjDb: true });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/health`);
        assert.equal(status, 200);
        assert.equal(body.status, 'degraded');
        assert.equal(body._freshness.exists, false);
      } finally {
        await srv.close();
      }
    });
  });

  describe('GET /api/products', () => {
    it('empty query returns recently updated products with total', async () => {
      const srv = await createTestServer({
        records: [
          productRec('paknsave:milk', { data: { name: 'Milk 1L' } }),
          productRec('paknsave:bread', { data: { name: 'White Bread' } }),
        ],
      });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/products`);
        assert.equal(status, 200);
        assert.equal(body.total, 2);
        assert.equal(body.products.length, 2);
        assert.equal(body.limit, 42);
        assert.equal(body.offset, 0);
      } finally {
        await srv.close();
      }
    });

    it('query matches products by name', async () => {
      const srv = await createTestServer({
        records: [
          productRec('paknsave:milk', { data: { name: 'Milk 1L' } }),
          productRec('paknsave:bread', { data: { name: 'White Bread' } }),
          productRec('newworld:milk-1l', { data: { name: 'Milk 1L' } }),
        ],
      });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/products?query=Milk`);
        assert.equal(status, 200);
        assert.equal(body.total, 2);
        assert.ok(body.products.every(p => p.name.toLowerCase().includes('milk')));
      } finally {
        await srv.close();
      }
    });

    it('no matches returns empty array', async () => {
      const srv = await createTestServer({
        records: [productRec('paknsave:milk', { data: { name: 'Milk' } })],
      });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/products?query=zzzznotfound`);
        assert.equal(status, 200);
        assert.equal(body.total, 0);
        assert.deepEqual(body.products, []);
      } finally {
        await srv.close();
      }
    });

    it('rejects query longer than 200 chars', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/products?query=${'a'.repeat(201)}`);
        assert.equal(status, 400);
        assert.equal(body.error.code, 'QUERY_TOO_LONG');
      } finally {
        await srv.close();
      }
    });

    it('caps limit at 200', async () => {
      const records = [];
      for (let i = 0; i < 50; i++) {
        records.push(productRec(`paknsave:p${i}`, { data: { name: `Product ${i}` } }));
      }
      const srv = await createTestServer({ records });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/products?limit=999`);
        assert.equal(status, 200);
        assert.ok(body.limit <= 200);
        assert.ok(body.products.length <= 200);
      } finally {
        await srv.close();
      }
    });

    it('respects offset and limit', async () => {
      const records = [];
      for (let i = 0; i < 10; i++) {
        records.push(productRec(`paknsave:p${i}`, { data: { name: `Product ${i}` } }));
      }
      const srv = await createTestServer({ records });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/products?limit=3&offset=5`);
        assert.equal(status, 200);
        assert.equal(body.limit, 3);
        assert.equal(body.offset, 5);
        assert.equal(body.products.length, 3);
      } finally {
        await srv.close();
      }
    });

    it('SQL injection strings return results without crash', async () => {
      const srv = await createTestServer({
        records: [productRec('paknsave:milk', { data: { name: 'Milk 1L' } })],
      });
      try {
        const payloads = [
          "milk' OR '1'='1",
          'milk"; DROP TABLE products; --',
          "milk\\'; SELECT * FROM users;",
        ];
        for (const q of payloads) {
          const { status, body } = await fetchJson(`${srv.baseUrl}/api/products?query=${encodeURIComponent(q)}`);
          assert.equal(status, 200);
          assert.ok(Array.isArray(body.products));
        }
      } finally {
        await srv.close();
      }
    });

    it('filters by retailer', async () => {
      const srv = await createTestServer({
        records: [
          productRec('paknsave:milk', { data: { name: 'Milk' } }),
          productRec('newworld:milk', { data: { name: 'Milk' } }),
        ],
      });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/products?retailer=newworld`);
        assert.equal(status, 200);
        assert.ok(body.products.every(p => p.retailerId === 'newworld'));
      } finally {
        await srv.close();
      }
    });
  });

  describe('GET /api/products/:productId', () => {
    it('returns product detail with offers', async () => {
      const srv = await createTestServer({
        records: [
          productRec('paknsave:milk', { data: { name: 'Milk 1L', categories: ['Dairy'] } }),
          storeRec('paknsave:royaloak', { data: { name: 'PAK\'nSAVE Royal Oak' } }),
          offerRec('paknsave:milk', 'paknsave:royaloak', { regularCents: 599 }),
        ],
      });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/products/paknsave:milk`);
        assert.equal(status, 200);
        assert.equal(body.product.id, 'paknsave:milk');
        assert.equal(body.product.name, 'Milk 1L');
        assert.equal(body.offers.length, 1);
        assert.equal(body.offers[0].cents.regular, 599);
        assert.equal(body.offers[0].priceContext.retailerId, 'paknsave');
      } finally {
        await srv.close();
      }
    });

    it('404 when product not found', async () => {
      const srv = await createTestServer({
        records: [productRec('paknsave:milk')],
      });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/products/paknsave:nonexistent`);
        assert.equal(status, 404);
        assert.equal(body.error.code, 'PRODUCT_NOT_FOUND');
      } finally {
        await srv.close();
      }
    });

    it('400 for invalid product ID format', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const cases = ['NOCOLON', 'bad:id!', 'UPPER:case', '../etc'];
        for (const pid of cases) {
          const { status, body } = await fetchJson(`${srv.baseUrl}/api/products/${encodeURIComponent(pid)}`);
          assert.equal(status, 400, `expected 400 for ${pid}`);
          assert.equal(body.error.code, 'INVALID_PRODUCT_ID');
        }
      } finally {
        await srv.close();
      }
    });

    it('returns fuzzy candidates separately from confirmed matches', async () => {
      const srv = await createTestServer({
        records: [
          productRec('paknsave:milk'),
          productRec('newworld:milk'),
          productRec('warehouse:milk'),
          storeRec('paknsave:royaloak'),
          storeRec('newworld:auckland'),
          storeRec('warehouse:national'),
        ],
        appDbInit: (appDb) => {
          appDb.createMatchPair({
            productAId: 'newworld:milk', productBId: 'paknsave:milk',
            matchMethod: 'auto_gtin', algorithmVersion: '1.0.0',
            confidence: 1.0, reviewState: 'confirmed', provenance: 'system', inputEvidenceHash: 'h1',
          });
          appDb.createMatchPair({
            productAId: 'warehouse:milk', productBId: 'paknsave:milk',
            matchMethod: 'fuzzy_candidate', algorithmVersion: '1.0.0',
            confidence: 0.5, reviewState: 'candidate', provenance: 'system', inputEvidenceHash: 'h2',
          });
        },
      });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/products/paknsave:milk`);
        assert.equal(status, 200);
        assert.equal(body.matches.length, 1, 'only confirmed matches');
        assert.equal(body.matches[0].method, 'auto_gtin');
        assert.equal(body.candidates.length, 1, 'fuzzy candidates separate');
        assert.equal(body.candidates[0].method, 'fuzzy_candidate');
        assert.equal(body.candidates[0].reviewState, 'candidate');
      } finally {
        await srv.close();
      }
    });

    it('product with no offers returns empty offers array', async () => {
      const srv = await createTestServer({
        records: [productRec('paknsave:milk', { data: { name: 'Milk 1L' } })],
      });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/products/paknsave:milk`);
        assert.equal(status, 200);
        assert.ok(body.product);
        assert.deepEqual(body.offers, []);
        assert.deepEqual(body.matches, []);
      } finally {
        await srv.close();
      }
    });

    it('includes matches from app DB when they exist', async () => {
      const srv = await createTestServer({
        records: [
          productRec('paknsave:milk'),
          productRec('newworld:milk'),
          storeRec('paknsave:royaloak'),
          storeRec('newworld:auckland'),
        ],
        appDbInit: (appDb) => {
          appDb.createMatchPair({
            productAId: 'newworld:milk',
            productBId: 'paknsave:milk',
            matchMethod: 'auto_gtin',
            algorithmVersion: '1.0.0',
            confidence: 1.0,
            reviewState: 'confirmed',
            provenance: 'system',
            inputEvidenceHash: 'h1',
          });
        },
      });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/products/paknsave:milk`);
        assert.equal(status, 200);
        assert.equal(body.matches.length, 1);
        assert.equal(body.matches[0].method, 'auto_gtin');
        assert.equal(body.candidates.length, 0);
      } finally {
        await srv.close();
      }
    });
  });

  describe('GET /api/products/:productId/history', () => {
    it('returns price history for a product', async () => {
      const srv = await createTestServer({
        records: [
          productRec('paknsave:milk', { data: { name: 'Milk 1L' } }),
          storeRec('paknsave:royaloak'),
          offerRec('paknsave:milk', 'paknsave:royaloak', { regularCents: 599 }),
          offerRec('paknsave:milk', 'paknsave:royaloak', { regularCents: 499 },
            { observedAt: '2026-07-14T12:00:00.000Z' }),
        ],
      });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/products/paknsave:milk/history`);
        assert.equal(status, 200);
        assert.equal(body.product.id, 'paknsave:milk');
        assert.ok(body.history.length > 0);
        assert.ok(body.history.every(h => typeof h.cents.regular === 'number'));
      } finally {
        await srv.close();
      }
    });

    it('404 when product not found', async () => {
      const srv = await createTestServer({
        records: [productRec('paknsave:milk')],
      });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/products/paknsave:nonexistent/history`);
        assert.equal(status, 404);
        assert.equal(body.error.code, 'PRODUCT_NOT_FOUND');
      } finally {
        await srv.close();
      }
    });

    it('400 for invalid product ID', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/products/invalid/history`);
        assert.equal(status, 400);
      } finally {
        await srv.close();
      }
    });

    it('empty history when product has no offers', async () => {
      const srv = await createTestServer({
        records: [productRec('paknsave:milk')],
      });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/products/paknsave:milk/history`);
        assert.equal(status, 200);
        assert.ok(body.product);
        assert.deepEqual(body.history, []);
      } finally {
        await srv.close();
      }
    });
  });

  describe('GET /api/stores', () => {
    it('returns stores list', async () => {
      const srv = await createTestServer({
        records: [
          storeRec('paknsave:royaloak', { data: { name: 'Royal Oak' } }),
          storeRec('newworld:auckland', { data: { name: 'Auckland' } }),
        ],
      });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/stores`);
        assert.equal(status, 200);
        assert.ok(body.stores.length >= 2);
        assert.ok(body.stores.some(s => s.storeName === 'Royal Oak'));
        assert.ok(body.stores.every(s => s.retailerId && s.storeId));
      } finally {
        await srv.close();
      }
    });

    it('returns empty array when no stores', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/stores`);
        assert.equal(status, 200);
        assert.deepEqual(body.stores, []);
      } finally {
        await srv.close();
      }
    });
  });

  describe('GET /api/search/suggestions', () => {
    it('returns suggestions matching query', async () => {
      const srv = await createTestServer({
        records: [
          productRec('paknsave:milk', { data: { name: 'Milk 1L' } }),
          productRec('paknsave:milk-2l', { data: { name: 'Milk 2L' } }),
          productRec('paknsave:bread', { data: { name: 'White Bread' } }),
        ],
      });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/search/suggestions?query=Mi`);
        assert.equal(status, 200);
        assert.ok(body.suggestions.length >= 2);
        assert.ok(body.suggestions.every(s => s.toLowerCase().includes('mi')));
      } finally {
        await srv.close();
      }
    });

    it('400 when query too short', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/search/suggestions?query=a`);
        assert.equal(status, 400);
        assert.equal(body.error.code, 'QUERY_TOO_SHORT');
      } finally {
        await srv.close();
      }
    });

    it('400 when query exceeds 100 chars', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/search/suggestions?query=${'a'.repeat(101)}`);
        assert.equal(status, 400);
        assert.equal(body.error.code, 'QUERY_TOO_LONG');
      } finally {
        await srv.close();
      }
    });

    it('empty suggestions when no match', async () => {
      const srv = await createTestServer({
        records: [productRec('paknsave:milk', { data: { name: 'Milk' } })],
      });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/search/suggestions?query=zz`);
        assert.equal(status, 200);
        assert.deepEqual(body.suggestions, []);
      } finally {
        await srv.close();
      }
    });

    it('handles SQL-injection strings gracefully', async () => {
      const srv = await createTestServer({
        records: [productRec('paknsave:milk', { data: { name: 'Milk' } })],
      });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/search/suggestions?query=${encodeURIComponent("'; DROP TABLE products; --")}`);
        assert.equal(status, 200);
        assert.ok(Array.isArray(body.suggestions));
      } finally {
        await srv.close();
      }
    });
  });

  describe('GET /api/deals', () => {
    it('returns empty arrays when no deals exist', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/deals`);
        assert.equal(status, 200);
        assert.deepEqual(body.historyBacked, []);
        assert.deepEqual(body.advertised, []);
        assert.ok(body.archiveFreshness);
        assert.equal(typeof body.total, 'number');
      } finally {
        await srv.close();
      }
    });

    it('returns shaped deals computed from offer data', async () => {
      const records = [
        productRec('paknsave:milk', { data: { name: 'Milk 1L', categories: ['Dairy'] } }),
        productRec('paknsave:bread', { data: { name: 'White Bread', categories: ['Bakery'] } }),
        storeRec('paknsave:royaloak', { data: { name: "PAK'nSAVE Royal Oak" } }),
        // 4 observations for milk — baseline (3) + current lower price
        offerRec('paknsave:milk', 'paknsave:royaloak', { regularCents: 599 },
          { observedAt: daysAgo(60) }),
        offerRec('paknsave:milk', 'paknsave:royaloak', { regularCents: 589 },
          { observedAt: daysAgo(45) }),
        offerRec('paknsave:milk', 'paknsave:royaloak', { regularCents: 579 },
          { observedAt: daysAgo(30) }),
        offerRec('paknsave:milk', 'paknsave:royaloak', { regularCents: 499 },
          { observedAt: daysAgo(1) }),
        // Bread with promotion data for advertised deal
        offerRec('paknsave:bread', 'paknsave:royaloak',
          { regularCents: 450, promoCents: 350 },
          { observedAt: daysAgo(1),
            promotion: { type: 'Super Saver', savePercent: 22, startsAt: daysAgo(2) } }),
      ];
      const srv = await createTestServer({ records });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/deals`);
        assert.equal(status, 200);
        assert.ok(body.historyBacked.length >= 1, 'should have history-backed deals from milk');
        assert.ok(body.advertised.length >= 1, 'should have advertised deals from bread');
        assert.ok(body.historyBacked[0].product);
        assert.ok(body.historyBacked[0].priceContext);
        assert.ok(body.historyBacked[0].signal);
        assert.ok(body.historyBacked[0].cents);
        assert.ok(body.archiveFreshness.totalStores > 0);
      } finally {
        await srv.close();
      }
    });

    it('baselines expired-promo samples at REGULAR cents [GROK-8 semantic fix]', async () => {
      // Golden-style proof of the CORE-4 promotion-window fix at the
      // /api/deals boundary. All three baseline samples carry stale
      // promoCents (400 vs 1000 regular) under a promotion that ENDED weeks
      // before they were collected; the current price is an honest 900c.
      //
      // Pre-fix semantics ignored promotion windows: baselines averaged
      // 400c, making the real price INCREASE read as a huge fake "drop"
      // computed against a dead promo — the deal surfaced with nonsense
      // numbers or was hidden entirely once minDropPercent filtering applied.
      // Post-fix semantics evaluate each sample's promotion activity at its
      // own observedAt: expired promo cents are ignored, baselines average
      // 1000c (regular), and the genuine 10% drop is reported.
      const records = [
        productRec('paknsave:golden', { data: { name: 'Golden Product' } }),
        storeRec('paknsave:royaloak'),
        ...[30, 25, 20].map((days) =>
          offerRec('paknsave:golden', 'paknsave:royaloak',
            { regularCents: 1000, promoCents: 400 },
            {
              observedAt: daysAgo(days),
              promotion: {
                type: 'Super Saver',
                savePercent: 60,
                startsAt: daysAgo(50),
                endsAt: daysAgo(45), // ended before every baseline sample
              },
            })),
        offerRec('paknsave:golden', 'paknsave:royaloak',
          { regularCents: 900 }, { observedAt: daysAgo(1) }),
      ];
      const srv = await createTestServer({ records });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/deals`);
        assert.equal(status, 200);
        const deal = body.historyBacked.find(d => d.product.id === 'paknsave:golden');
        assert.ok(deal, 'stale-promo product must surface as a history-backed deal');
        assert.equal(deal.signal.referenceCents, 1000, 'baseline at REGULAR cents, NOT the dead 400c promo');
        assert.equal(deal.signal.currentCents, 900);
        assert.equal(deal.signal.dropPercent, 10);
        assert.equal(deal.cents.regular, 1000);
        // 900c really is the lowest effective price on record (baselines are
        // 1000c regular once dead promos are ignored), so all_time_low —
        // NOT history_drop — is the correct classification here.
        assert.equal(deal.signal.kind, 'all_time_low');
      } finally {
        await srv.close();
      }
    });

    it('filters by retailer', async () => {
      const records = [
        productRec('paknsave:milk', { data: { name: 'Milk' } }),
        productRec('newworld:milk', { data: { name: 'Milk NW' } }),
        storeRec('paknsave:royaloak', { data: { name: 'Royal Oak' } }),
        storeRec('newworld:auckland', { data: { name: 'Auckland' } }),
        // 4 observations per product for history-backed deals
        offerRec('paknsave:milk', 'paknsave:royaloak', { regularCents: 599 },
          { observedAt: daysAgo(60) }),
        offerRec('paknsave:milk', 'paknsave:royaloak', { regularCents: 589 },
          { observedAt: daysAgo(45) }),
        offerRec('paknsave:milk', 'paknsave:royaloak', { regularCents: 579 },
          { observedAt: daysAgo(30) }),
        offerRec('paknsave:milk', 'paknsave:royaloak', { regularCents: 499 },
          { observedAt: daysAgo(1) }),
        offerRec('newworld:milk', 'newworld:auckland', { regularCents: 699 },
          { observedAt: daysAgo(60) }),
        offerRec('newworld:milk', 'newworld:auckland', { regularCents: 679 },
          { observedAt: daysAgo(45) }),
        offerRec('newworld:milk', 'newworld:auckland', { regularCents: 659 },
          { observedAt: daysAgo(30) }),
        offerRec('newworld:milk', 'newworld:auckland', { regularCents: 599 },
          { observedAt: daysAgo(1) }),
      ];
      const srv = await createTestServer({ records });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/deals?retailer=paknsave`);
        assert.equal(status, 200);
        assert.ok(body.historyBacked.every(d => d.priceContext.retailerId === 'paknsave'));
      } finally {
        await srv.close();
      }
    });

    it('promo equal to regular is NOT a deal; promo lower is a deal', async () => {
      const records = [
        productRec('paknsave:equal', { data: { name: 'Equal Price' } }),
        productRec('paknsave:lower', { data: { name: 'Lower Price' } }),
        storeRec('paknsave:royaloak'),
        // Promo == regular — NOT a deal
        offerRec('paknsave:equal', 'paknsave:royaloak',
          { regularCents: 500, promoCents: 500 },
          { observedAt: daysAgo(1),
            promotion: { type: 'NEW_PRICE' } }),
        // Promo < regular — IS a deal
        offerRec('paknsave:lower', 'paknsave:royaloak',
          { regularCents: 500, promoCents: 400 },
          { observedAt: daysAgo(1),
            promotion: { type: 'Super Saver', savePercent: 20 } }),
      ];
      const srv = await createTestServer({ records });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/deals`);
        assert.equal(status, 200);
        const advertisedNames = body.advertised.map(d => d.product.name);
        assert.ok(!advertisedNames.includes('Equal Price'), 'promo==regular must NOT be a deal');
        assert.ok(advertisedNames.includes('Lower Price'), 'promo<regular must be a deal');
      } finally {
        await srv.close();
      }
    });

    it('rejects invalid filter value', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/deals?filter=bogus`);
        assert.equal(status, 400);
        assert.equal(body.error.code, 'INVALID_FILTER');
      } finally {
        await srv.close();
      }
    });

    it('caps limit at 200', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/deals?limit=999`);
        assert.equal(status, 200);
        assert.ok(body.limit <= 200, 'limit param capped');
      } finally {
        await srv.close();
      }
    });

    it('limit caps combined historyBacked + advertised length', async () => {
      // Create 3 products with multiple offers each to generate deals
      const records = [];
      for (const name of ['prod-a', 'prod-b', 'prod-c']) {
        records.push(productRec(`paknsave:${name}`, { data: { name } }));
        records.push(storeRec('paknsave:royaloak'));
        // 4 observations for history-backed eligibility
        for (const [price, dayOffset] of [[599, 60], [589, 45], [579, 30], [499, 1]]) {
          records.push(offerRec(`paknsave:${name}`, 'paknsave:royaloak',
            { regularCents: price },
            { observedAt: daysAgo(dayOffset) }));
        }
        // Also an advertised deal observation
        records.push(offerRec(`paknsave:${name}`, 'paknsave:royaloak',
          { regularCents: 500, promoCents: 400 },
          { observedAt: daysAgo(1),
            promotion: { type: 'Super Saver', savePercent: 20 } }));
      }
      const srv = await createTestServer({ records });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/deals?limit=2`);
        assert.equal(status, 200);
        const combined = body.historyBacked.length + body.advertised.length;
        assert.ok(combined <= 2, `combined length ${combined} must be ≤ 2`);
        assert.ok(body.total >= combined, `total ${body.total} ≥ combined ${combined}`);
        assert.ok(Number.isFinite(body.total) && body.total > 2, 'total reflects pre-cap count');
        assert.equal(body.limit, 2);
      } finally {
        await srv.close();
      }
    });

    it('deduplicates — product in both history+advertised appears only once', async () => {
      // Create a product that qualifies for both history-backed and advertised
      const records = [
        productRec('paknsave:dual', { data: { name: 'Dual Product' } }),
        storeRec('paknsave:royaloak'),
        // 4 observations: last is lower = history-backed eligible
        offerRec('paknsave:dual', 'paknsave:royaloak', { regularCents: 599 },
          { observedAt: daysAgo(60) }),
        offerRec('paknsave:dual', 'paknsave:royaloak', { regularCents: 589 },
          { observedAt: daysAgo(45) }),
        offerRec('paknsave:dual', 'paknsave:royaloak', { regularCents: 579 },
          { observedAt: daysAgo(30) }),
        // Lowest price — makes it history-backed
        offerRec('paknsave:dual', 'paknsave:royaloak', { regularCents: 499, promoCents: 499 },
          { observedAt: daysAgo(1),
            promotion: { type: 'Super Saver', savePercent: 0 } }),
      ];
      const srv = await createTestServer({ records });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/deals`);
        assert.equal(status, 200);
        const historyIds = body.historyBacked.map(d => d.product.id);
        const advertisedIds = body.advertised.map(d => d.product.id);
        // The same product ID should NOT appear in both arrays
        for (const id of historyIds) {
          assert.ok(!advertisedIds.includes(id),
            `product ${id} must not appear in both history and advertised`);
        }
      } finally {
        await srv.close();
      }
    });
  });

  describe('error cases', () => {
    it('404 for unknown route', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/nonexistent`);
        assert.equal(status, 404);
        assert.equal(body.error.code, 'NOT_FOUND');
      } finally {
        await srv.close();
      }
    });

    it('405 for wrong method', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { status, body } = await fetchJson(`${srv.baseUrl}/api/health`, { method: 'POST' });
        assert.equal(status, 405);
        assert.equal(body.error.code, 'METHOD_NOT_ALLOWED');
      } finally {
        await srv.close();
      }
    });

    it('responses include _requestId and _freshness', async () => {
      const srv = await createTestServer({
        records: [productRec('paknsave:milk')],
      });
      try {
        const { body } = await fetchJson(`${srv.baseUrl}/api/products?query=milk`);
        assert.ok(body._requestId);
        assert.ok(body._freshness);
        assert.ok(body._freshness.exists);
        assert.ok(body._freshness.fingerprint);
      } finally {
        await srv.close();
      }
    });

    it('error responses include _requestId and _freshness', async () => {
      const srv = await createTestServer({ records: [] });
      try {
        const { body } = await fetchJson(`${srv.baseUrl}/api/nonexistent`);
        assert.ok(body._requestId);
        assert.ok(body._freshness);
      } finally {
        await srv.close();
      }
    });
  });

  describe('service unavailable when DB missing', () => {
    it('product endpoints return 503 when no projection DB', async () => {
      const srv = await createTestServer({ records: [], skipProjDb: true });
      try {
        const endpoints = [
          '/api/products',
          '/api/products/paknsave:milk',
          '/api/products/paknsave:milk/history',
          '/api/stores',
          '/api/search/suggestions?query=mi',
          '/api/deals',
        ];
        for (const ep of endpoints) {
          const { status } = await fetchJson(`${srv.baseUrl}${ep}`);
          assert.equal(status, 503, `expected 503 for ${ep}`);
        }
      } finally {
        await srv.close();
      }
    });
  });
});
