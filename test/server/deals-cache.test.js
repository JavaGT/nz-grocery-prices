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

// listDeals returns a CachedResponse for anonymous requests (the transport
// reuses its encoded bytes); unwrap for shape assertions.
const bodyOf = (res) => (res instanceof Object && 'body' in res ? res.body : res);

function makeHandlers({ dealsCacheTtlMs, dbSignature, observations = fixtures } = {}) {
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
    dbSignature,
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
  const first = bodyOf(await h.handlers.listDeals({ query: {}, clock: h.now }));
  const second = bodyOf(await h.handlers.listDeals({ query: {}, clock: h.now }));
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

test('dbSignature change invalidates within the TTL', async () => {
  let sig = 1000;
  const h = makeHandlers({ dealsCacheTtlMs: 600_000, dbSignature: () => sig });
  await h.handlers.listDeals({ query: {}, clock: h.now });
  await h.handlers.listDeals({ query: {}, clock: h.now });
  assert.equal(h.calls(), 1, 'stable signature still caches');
  sig = 2000; // projection DB replaced on disk
  await h.handlers.listDeals({ query: {}, clock: h.now });
  assert.equal(h.calls(), 2, 'signature change must recompute immediately');
});

test('absent dbSignature keeps TTL-only behavior', async () => {
  const h = makeHandlers({ dealsCacheTtlMs: 600_000 });
  await h.handlers.listDeals({ query: {}, clock: h.now });
  await h.handlers.listDeals({ query: {}, clock: h.now });
  assert.equal(h.calls(), 1);
});

test('caches per retailer', async () => {
  const h = makeHandlers({ dealsCacheTtlMs: 60_000 });
  const pn1 = bodyOf(await h.handlers.listDeals({ query: { retailer: 'paknsave' }, clock: h.now }));
  const pn2 = bodyOf(await h.handlers.listDeals({ query: { retailer: 'paknsave' }, clock: h.now }));
  const ww = bodyOf(await h.handlers.listDeals({ query: { retailer: 'woolworths' }, clock: h.now }));
  assert.equal(h.calls(), 2, 'paknsave hit, woolworths computed');
  assert.deepEqual(pn2, pn1);
  assert.equal(pn1.historyBacked.length, 1);
  assert.equal(pn1.advertised.length, 0);
  assert.deepEqual(ww.advertised.map(d => d.priceContext.retailerId), ['woolworths']);
});

test('filter and limit still apply to cached results', async () => {
  const h = makeHandlers({ dealsCacheTtlMs: 60_000 });
  const all = bodyOf(await h.handlers.listDeals({ query: {}, clock: h.now }));
  const ads = bodyOf(await h.handlers.listDeals({ query: { filter: 'advertised' }, clock: h.now }));
  const capped = bodyOf(await h.handlers.listDeals({ query: { limit: '1' }, clock: h.now }));
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

  const plain = bodyOf(await handlers.listDeals(plainCtx));
  for (const deal of [...plain.historyBacked, ...plain.advertised]) {
    assert.equal(deal.tier, undefined, 'cached objects must not leak tier into other requests');
  }

  const tieredAgain = await handlers.listDeals(authedCtx);
  assert.equal(tieredAgain.historyBacked.find(d => d.product.id === 'ps:milk-1')?.tier, 'watch-other');
});

test('anonymous responses are CachedResponse; tiered responses stay plain', async () => {
  const { CachedResponse } = await import('../../src/server/server.js');
  const h = makeHandlers({ dealsCacheTtlMs: 60_000 });
  const plain = await h.handlers.listDeals({ query: {}, clock: h.now });
  assert.ok(plain instanceof CachedResponse, 'anonymous path returns CachedResponse');
  assert.equal(plain.maxAgeMs, 60_000);
  assert.match(plain.token, /^\*\|undefined\|/);
  assert.equal(plain.body.total, 2);

  const appDb = {
    getWatchList: () => [{ target_kind: 'product', target_id: 'ps:milk-1' }],
    getStorePreferences: () => [],
  };
  const handlers = createPublicHandlers({
    getDb: fakeDb,
    appDb,
    auth: { getSessionUser: () => ({ id: 'u1' }) },
    clock: () => NOW,
    queryDbObservations: () => fixtures(),
    dealsCacheTtlMs: 60_000,
  });
  const tiered = await handlers.listDeals({ query: {}, clock: () => NOW, cookies: { sid: 's1' } });
  assert.ok(!(tiered instanceof CachedResponse), 'tiered path must stay a plain body');
  assert.ok(tiered.tiers, 'tiered response carries tier summary');
});

// Single-flight harness: queryDbObservations returns promises the test
// resolves manually, so concurrent cold requests overlap for real.
function deferredHandlers() {
  let startCount = 0;
  const resolvers = [];
  const handlers = createPublicHandlers({
    getDb: fakeDb,
    clock: () => NOW,
    queryDbObservations: () => new Promise(resolve => {
      startCount += 1;
      resolvers.push(() => resolve(fixtures()));
    }),
    dealsCacheTtlMs: 60_000,
  });
  return {
    handlers,
    starts: () => startCount,
    resolveAll: () => { while (resolvers.length) resolvers.shift()(); },
  };
}

test('concurrent cold requests share one computation', async () => {
  const h = deferredHandlers();
  const pending = Array.from({ length: 8 }, () =>
    h.handlers.listDeals({ query: {}, clock: () => NOW }));
  assert.equal(h.starts(), 1, 'only the first caller starts a computation');
  h.resolveAll();
  const results = await Promise.all(pending);
  assert.equal(h.starts(), 1, 'still one computation after all resolve');
  const bodies = results.map(bodyOf);
  for (const body of bodies) assert.deepEqual(body, bodies[0]);
  assert.equal(bodies[0].total, 2);
});

test('a failed computation does not stick; the next request recomputes', async () => {
  let startCount = 0;
  let fail = true;
  const handlers = createPublicHandlers({
    getDb: fakeDb,
    clock: () => NOW,
    queryDbObservations: () => {
      startCount += 1;
      return fail
        ? Promise.reject(new Error('observation query failed'))
        : Promise.resolve(fixtures());
    },
    dealsCacheTtlMs: 60_000,
  });
  await assert.rejects(
    handlers.listDeals({ query: {}, clock: () => NOW }),
    /observation query failed/,
  );
  fail = false;
  const body = bodyOf(await handlers.listDeals({ query: {}, clock: () => NOW }));
  assert.equal(startCount, 2, 'rejection must be evicted from the pending slot');
  assert.equal(body.total, 2, 'the retry succeeds and serves deals');
});

test('concurrent requests for different retailers compute independently', async () => {
  const h = deferredHandlers();
  const pn = h.handlers.listDeals({ query: { retailer: 'paknsave' }, clock: () => NOW });
  const ww = h.handlers.listDeals({ query: { retailer: 'woolworths' }, clock: () => NOW });
  assert.equal(h.starts(), 2, 'each retailer key runs its own computation');
  h.resolveAll();
  const [pnBody, wwBody] = await Promise.all([pn, ww]);
  assert.equal(bodyOf(pnBody).historyBacked[0].priceContext.retailerId, 'paknsave');
  assert.equal(bodyOf(wwBody).advertised[0].priceContext.retailerId, 'woolworths');
});
