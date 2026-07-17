import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroceryPricesApp, priceContextFor } from '../server.mjs';

const observation = {
  observedAt: '2026-07-16T00:00:00.000Z',
  product: {
    id: 'foodstuffs:milk',
    name: 'Anchor Blue Milk 2L',
    brand: 'Anchor',
    categories: ['Milk'],
    images: {
      200: 'https://example.test/milk-200.png',
      400: 'https://example.test/milk-400.png',
    },
  },
  store: { id: 'paknsave:royal-oak', retailer: 'paknsave', name: 'Royal Oak' },
  price: { currency: 'NZD', regularCents: 629, promoCents: 479 },
};

const sale = {
  productId: 'foodstuffs:milk',
  productName: 'Anchor Blue Milk 2L',
  brand: 'Anchor',
  storeId: 'paknsave:royal-oak',
  storeName: 'Royal Oak',
  retailer: 'paknsave',
  currentCents: 479,
  baselineAverageCents: 629,
  dropPercent: 23.8,
  isAllTimeLow: true,
  observedAt: '2026-07-16T00:00:00.000Z',
  promotion: { type: 'SPECIAL' },
};

const advertised = {
  productId: 'woolworths:timtam',
  productName: 'Tim Tam Original 200g',
  storeId: 'woolworths:glenfield',
  storeName: 'Glenfield',
  retailer: 'woolworths',
  currentCents: 250,
  regularCents: 420,
  savePercent: 40.5,
  observedAt: '2026-07-16T00:00:00.000Z',
};

function mockArchive(overrides = {}) {
  return {
    history: async () => [observation],
    agentFeed: async () => ({
      generatedAt: '2026-07-16T01:00:00.000Z',
      currency: 'NZD',
      sales: [sale],
      ongoingSales: [advertised],
    }),
    ...overrides,
  };
}

async function withApp(archive, run) {
  const app = createGroceryPricesApp({ archive, db: ':memory:' });
  app.listen(0);
  await app.ready;
  try {
    const { port } = app.httpServer.address();
    return await run(port);
  } finally {
    app.httpServer.close();
  }
}

test('priceContextFor maps retailer scopes explicitly', () => {
  assert.deepEqual(priceContextFor({ retailer: 'paknsave', name: 'Royal Oak' }), {
    kind: 'physical-store',
    label: 'Royal Oak store price',
  });
  assert.deepEqual(priceContextFor({ retailer: 'woolworths', name: 'Glenfield' }), {
    kind: 'fulfilment-store',
    label: 'Glenfield pickup/fulfilment price',
  });
  assert.deepEqual(priceContextFor({ retailer: 'warehouse', name: 'Online' }), {
    kind: 'national-online',
    label: 'The Warehouse national online catalogue price',
  });
});

test('public product search is available without a session and includes price context', async () => {
  await withApp(mockArchive(), async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/products?query=milk&limit=1`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.limit, 1);
    assert.equal(body.total, 1);
    assert.equal(body.products[0].id, 'foodstuffs:milk');
    assert.equal(body.products[0].currentCents, 479);
    assert.equal(body.products[0].imageUrl, 'https://example.test/milk-400.png');
    assert.deepEqual(body.products[0].priceContext, {
      kind: 'physical-store',
      label: 'Royal Oak store price',
    });
  });
});

test('product list interleaves retailers so one chain cannot fill the first page', async () => {
  const observations = [
    {
      observedAt: '2026-07-17T12:00:00.000Z',
      product: { id: 'foodstuffs:a', name: 'PnS A', brand: 'A', categories: [], images: [] },
      store: { id: 'paknsave:1', retailer: 'paknsave', name: 'PnS One' },
      price: { regularCents: 100 },
    },
    {
      observedAt: '2026-07-17T11:00:00.000Z',
      product: { id: 'foodstuffs:b', name: 'PnS B', brand: 'B', categories: [], images: [] },
      store: { id: 'paknsave:1', retailer: 'paknsave', name: 'PnS One' },
      price: { regularCents: 200 },
    },
    {
      observedAt: '2026-07-16T10:00:00.000Z',
      product: { id: 'woolworths:c', name: 'WW C', brand: 'C', categories: [], images: [] },
      store: { id: 'woolworths:1', retailer: 'woolworths', name: 'WW One' },
      price: { regularCents: 300 },
    },
    {
      observedAt: '2026-07-16T09:00:00.000Z',
      product: { id: 'foodstuffs:a', name: 'NW A', brand: 'A', categories: [], images: [] },
      store: { id: 'newworld:1', retailer: 'newworld', name: 'NW One' },
      price: { regularCents: 150 },
    },
  ];
  await withApp(mockArchive({
    history: async (query = {}) => {
      if (query.retailer) {
        return observations.filter((o) => o.store?.retailer === query.retailer);
      }
      return observations;
    },
  }), async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/products?limit=10`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.total, 4);
    const retailers = body.products.map((p) => p.retailer);
    assert.deepEqual(retailers.slice(0, 3).sort(), ['newworld', 'paknsave', 'woolworths']);
    const wwOnly = await fetch(`http://127.0.0.1:${port}/api/products?retailer=woolworths`);
    const wwBody = await wwOnly.json();
    assert.equal(wwBody.total, 1);
    assert.equal(wwBody.products[0].retailer, 'woolworths');
  });
});

test('public deals endpoint returns shaped history-backed and advertised feeds', async () => {
  await withApp(mockArchive(), async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/deals`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.freshWithinDays, 7);
    assert.equal(body.historyBacked.length, 1);
    assert.equal(body.historyBacked[0].signalLabel, 'New all-time low');
    assert.deepEqual(body.historyBacked[0].priceContext, {
      kind: 'physical-store',
      label: 'Royal Oak store price',
    });
    assert.equal(body.advertised.length, 1);
    assert.equal(body.advertised[0].signalLabel, 'Advertised special');
    assert.deepEqual(body.advertised[0].priceContext, {
      kind: 'fulfilment-store',
      label: 'Glenfield pickup/fulfilment price',
    });
  });
});

test('product history includes sparkline points', async () => {
  await withApp(mockArchive(), async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/products/foodstuffs%3Amilk/history`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.productId, 'foodstuffs:milk');
    assert.equal(body.sparkline.length, 1);
    assert.equal(body.sparkline[0].cents, 479);
  });
});

test('watch list writes remain private behind Workbench authentication', async () => {
  await withApp(mockArchive({ history: async () => [] }), async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/watch-list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        targetKind: 'product',
        targetId: 'foodstuffs:milk',
        label: 'Anchor Blue Milk 2L',
      }),
    });
    assert.equal(response.status, 401);
  });
});

test('preferred store writes remain private behind Workbench authentication', async () => {
  await withApp(mockArchive({ history: async () => [] }), async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/preferred-stores`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        storeId: 'paknsave:royal-oak',
        storeName: 'Royal Oak',
        retailer: 'paknsave',
        rank: 0,
      }),
    });
    assert.equal(response.status, 401);
  });
});

test('root serves the navigable NZ Grocery dashboard', async () => {
  await withApp(mockArchive({ history: async () => [] }), async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type') || '', /text\/html/);
    const html = await response.text();
    assert.match(html, /NZ Grocery Prices/);
    assert.match(html, /#deals/);
    assert.match(html, /#browse/);
    assert.match(html, /Grid/);
    assert.match(html, /List/);
  });
});

test('public stats endpoint summarises archive observations', async () => {
  await withApp(mockArchive(), async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/stats`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.totalProducts, 1);
    assert.equal(body.totalStores, 1);
    assert.equal(body.totalObservations, 1);
    assert.deepEqual(body.retailers, ['paknsave']);
  });
});
