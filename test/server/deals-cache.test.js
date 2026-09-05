// Unit tests for the /api/deals memoization (dealUniverse) in
// src/server/handlers/public.js. The computation is canned via an injected
// queryDbObservations counter; deal shaping itself is covered by
// test/server/public-api.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicHandlers } from '../../src/server/handlers/public.js';

const HOUR = 3600_000;
const DAY = 86_400_000;
const NOW = 1_700_000_000_000;

function fixtures() {
  const obs = (over = {}) => ({
    product: { id: 'ps:milk-1', name: 'Milk 1L', brand: 'Anchor', categories: ['dairy'], images: [] },
    store: { id: 'ps-royal-oak', name: 'Royal Oak', retailer: 'paknsave' },
    price: { regularCents: 300 },
    observedAt: new Date(NOW - 1 * HOUR).toISOString(),
    lastSeenAt: new Date(NOW - 1 * HOUR).toISOString(),
    ...over,
  });

  return [
    // history-backed: 4 baseline samples at 300, current at 200 (~33% drop)
    ...[30, 25, 20, 15].map(daysAgo => obs({
      observedAt: new Date(NOW - daysAgo * DAY).toISOString(),
      lastSeenAt: new Date(NOW - daysAgo * DAY).toISOString(),
    })),
    obs({ price: { regularCents: 200 } }),
    // advertised: promo live now
    obs({
      product: { id: 'ww:bread-1', name: 'Bread', brand: 'Vogel', categories: ['bakery'], images: [] },
      store: { id: 'ww-online', name: 'Woolworths Online', retailer: 'woolworths' },
      price: { regularCents: 250, promoCents: 200 },
      promotion: { savePercent: 20 },
      isOnSpecial: true,
    }),
  ];
}

function fakeDb() {
  return {
    prepare: (sql) => ({
      get: () => (sql.includes('price_contexts') ? { total: 5 } : { c: 3 }),
      all: () => [],
    }),
  };
}

function makeHandlers({ dealsCacheTtlMs, observations = fixtures } = {}) {
  let queryCount = 0;
  let now = NOW;
  const handlers = createPublicHandlers({
    getDb: fakeDb,
    clock: () => now,
    queryDbObservations: () => {
      queryCount += 1;
      return observations();
    },
    dealsCacheTtlMs,
  });
  return {
    handlers,
    calls: () => queryCount,
    now: () => now,
    advance: (ms) => { now += ms; },
  };
}

test('caches the deal computation within the TTL', async () => {
  const h = makeHandlers({ dealsCacheTtlMs: 60_000 });
  const first = await h.handlers.listDeals({ query: {}, clock: h.now });
  const second = await h.handlers.listDeals({ query: {}, clock: h.now });
  assert.equal(h.calls(), 1, 'second request must not recompute');
  assert.deepEqual(second, first);
  assert.equal(first.historyBacked.length, 1);
  assert.equal(first.advertised.length, 1);
  assert.equal(first.total, 2);
});

test('recomputes after the TTL elapses', async () => {
  const h = makeHandlers({ dealsCacheTtlMs: 60_000 });
  await h.handlers.listDeals({ query: {}, clock: h.now });
  h.advance(61_000);
  await h.handlers.listDeals({ query: {}, clock: h.now });
  assert.equal(h.calls(), 2, 'TTL expiry must force a recompute');
});

test('dealsCacheTtlMs 0 disables caching', async () => {
  const h = makeHandlers({ dealsCacheTtlMs: 0 });
  await h.handlers.listDeals({ query: {}, clock: h.now });
  await h.handlers.listDeals({ query: {}, clock: h.now });
  assert.equal(h.calls(), 2);
});

test('caches per retailer', async () => {
  const h = makeHandlers({ dealsCacheTtlMs: 60_000 });
  const pn1 = await h.handlers.listDeals({ query: { retailer: 'paknsave' }, clock: h.now });
  const pn2 = await h.handlers.listDeals({ query: { retailer: 'paknsave' }, clock: h.now });
  const ww = await h.handlers.listDeals({ query: { retailer: 'woolworths' }, clock: h.now });
  assert.equal(h.calls(), 2, 'paknsave hit, woolworths computed');
  assert.deepEqual(pn2, pn1);
  assert.equal(pn1.historyBacked.length, 1);
  assert.equal(pn1.advertised.length, 0);
  assert.deepEqual(ww.advertised.map(d => d.priceContext.retailerId), ['woolworths']);
});

test('filter and limit still apply to cached results', async () => {
  const h = makeHandlers({ dealsCacheTtlMs: 60_000 });
  const all = await h.handlers.listDeals({ query: {}, clock: h.now });
  const ads = await h.handlers.listDeals({ query: { filter: 'advertised' }, clock: h.now });
  const capped = await h.handlers.listDeals({ query: { limit: '1' }, clock: h.now });
  assert.equal(h.calls(), 1, 'all three served from one computation');
  assert.equal(ads.total, 1);
  assert.equal(ads.advertised.length, 1);
  assert.equal(ads.historyBacked.length, 0);
  assert.equal(capped.total, all.total, 'limit caps the page, not the total');
  assert.equal(capped.historyBacked.length + capped.advertised.length, 1);
});

test('tiered requests do not mutate cached deal objects', async () => {
  const h = makeHandlers({ dealsCacheTtlMs: 60_000 });
  const tiers = {
    getSessionUser: () => ({ id: 'u1' }),
  };
  const appDb = {
    getWatchList: () => [{ target_kind: 'product', target_id: 'ps:milk-1' }],
    getStorePreferences: () => [],
  };
  const authedCtx = { query: {}, clock: () => NOW, cookies: { sid: 's1' } };
  const plainCtx = { query: {}, clock: () => NOW };

  const handlers = createPublicHandlers({
    getDb: fakeDb,
    appDb,
    auth: tiers,
    clock: () => NOW,
    queryDbObservations: () => fixtures(),
    dealsCacheTtlMs: 60_000,
  });

  const tiered = await handlers.listDeals(authedCtx);
  const milk = tiered.historyBacked.find(d => d.product.id === 'ps:milk-1');
  assert.ok(milk, 'watched product present');
  assert.equal(milk.tier, 'watch-other', 'watched product at non-preferred store tiers as watch-other');

  const plain = await handlers.listDeals(plainCtx);
  for (const deal of [...plain.historyBacked, ...plain.advertised]) {
    assert.equal(deal.tier, undefined, 'cached objects must not leak tier into other requests');
  }

  const tieredAgain = await handlers.listDeals(authedCtx);
  assert.equal(tieredAgain.historyBacked.find(d => d.product.id === 'ps:milk-1')?.tier, 'watch-other');
});
