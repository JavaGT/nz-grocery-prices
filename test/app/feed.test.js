import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestServer, productRec, storeRec, offerRec } from '../server/server-helpers.js';

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const body = await res.json();
  return { status: res.status, headers: res.headers, body };
}

function extractSid(headers) {
  const setCookie = headers.get('set-cookie');
  if (!setCookie) return null;
  const m = setCookie.match(/sid=([^;]+)/);
  return m ? m[1] : null;
}

async function registerAndLogin(baseUrl, username, password) {
  await fetchJson(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const loginRes = await fetchJson(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const sid = extractSid(loginRes.headers);
  assert.ok(sid, 'login should set sid cookie');
  return { sid, user: loginRes.body.user };
}

function buildDealsFixture() {
  return [
    productRec('paknsave:milk', { data: { name: 'Milk 1L', categories: ['Dairy'] } }),
    productRec('paknsave:bread', { data: { name: 'White Bread', categories: ['Bakery'] } }),
    productRec('paknsave:butter', { data: { name: 'Butter 500g', categories: ['Dairy'] } }),
    storeRec('paknsave:royaloak', { data: { name: "PAK'nSAVE Royal Oak" } }),
    storeRec('paknsave:chartwell', { data: { name: "PAK'nSAVE Chartwell" } }),
    // Milk at royal oak — history-backed drop (watch-list product, preferred store)
    offerRec('paknsave:milk', 'paknsave:royaloak', { regularCents: 599 },
      { observedAt: '2026-06-01T12:00:00.000Z' }),
    offerRec('paknsave:milk', 'paknsave:royaloak', { regularCents: 589 },
      { observedAt: '2026-06-15T12:00:00.000Z' }),
    offerRec('paknsave:milk', 'paknsave:royaloak', { regularCents: 579 },
      { observedAt: '2026-07-01T12:00:00.000Z' }),
    offerRec('paknsave:milk', 'paknsave:royaloak', { regularCents: 499 },
      { observedAt: '2026-07-15T10:00:00.000Z' }),
    // Milk at chartwell — history-backed drop (watch-list product, non-preferred store)
    offerRec('paknsave:milk', 'paknsave:chartwell', { regularCents: 599 },
      { observedAt: '2026-06-01T12:00:00.000Z' }),
    offerRec('paknsave:milk', 'paknsave:chartwell', { regularCents: 589 },
      { observedAt: '2026-06-15T12:00:00.000Z' }),
    offerRec('paknsave:milk', 'paknsave:chartwell', { regularCents: 579 },
      { observedAt: '2026-07-01T12:00:00.000Z' }),
    offerRec('paknsave:milk', 'paknsave:chartwell', { regularCents: 509 },
      { observedAt: '2026-07-15T10:00:00.000Z' }),
    // Bread at royal oak — advertised deal (not on watch list)
    offerRec('paknsave:bread', 'paknsave:royaloak',
      { regularCents: 450, promoCents: 350 },
      { observedAt: '2026-07-15T10:00:00.000Z',
        promotion: { type: 'Super Saver', savePercent: 22, startsAt: '2026-07-14T00:00:00.000Z' } }),
    // Butter at chartwell — advertised deal (not on watch list)
    offerRec('paknsave:butter', 'paknsave:chartwell',
      { regularCents: 800, promoCents: 600 },
      { observedAt: '2026-07-15T10:00:00.000Z',
        promotion: { type: 'Super Saver', savePercent: 25, startsAt: '2026-07-14T00:00:00.000Z' } }),
  ];
}

describe('GET /api/deals feed prioritization', () => {

  it('returns empty arrays (not error) when no deals exist', async () => {
    const srv = await createTestServer({ records: [] });
    try {
      const { status, body } = await fetchJson(`${srv.baseUrl}/api/deals`);
      assert.equal(status, 200);
      assert.deepEqual(body.historyBacked, []);
      assert.deepEqual(body.advertised, []);
      assert.equal(body.stale, false);
      assert.ok(body.archiveFreshness);
      assert.equal(typeof body.total, 'number');
    } finally {
      await srv.close();
    }
  });

  it('returns 503 when projection DB is unavailable', async () => {
    const srv = await createTestServer({ records: [], skipProjDb: true });
    try {
      const { status } = await fetchJson(`${srv.baseUrl}/api/deals`);
      assert.equal(status, 503);
    } finally {
      await srv.close();
    }
  });

  it('unauthenticated request has no tiers field (flat ordering)', async () => {
    const srv = await createTestServer({ records: buildDealsFixture() });
    try {
      const { status, body } = await fetchJson(`${srv.baseUrl}/api/deals`);
      assert.equal(status, 200);
      assert.equal(body.tiers, undefined);
      assert.ok(body.historyBacked.length + body.advertised.length > 0);
    } finally {
      await srv.close();
    }
  });

  it('prioritizes watch-list products at preferred stores first', async () => {
    const srv = await createTestServer({
      records: buildDealsFixture(),
      appDbInit(appDb) {
        const user = appDb.createUser('feeduser', 'dummyhash');
        appDb.addWatchListEntry(user.id, 'product', 'paknsave:milk', 'Milk 1L');
      },
    });
    try {
      const { sid } = await registerAndLogin(srv.baseUrl, 'feeduser2', 'password123');

      // The appDbInit created a user with id 1, but registerAndLogin creates a new user.
      // We need the watch-list + prefs on the LOGGED IN user. Use the API.
      await fetchJson(`${srv.baseUrl}/api/watch-list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `sid=${sid}` },
        body: JSON.stringify({ targetKind: 'product', targetId: 'paknsave:milk', label: 'Milk 1L' }),
      });

      // Find the price_contexts id for paknsave:royaloak to set as preferred store
      const ctxRows = srv.projDb.prepare(
        'SELECT id, store_id FROM price_contexts WHERE store_id = ?'
      ).all('paknsave:royaloak');
      assert.ok(ctxRows.length > 0, 'royal oak price context should exist');
      const royalOakContextId = ctxRows[0].id;

      await fetchJson(`${srv.baseUrl}/api/preferred-stores`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `sid=${sid}` },
        body: JSON.stringify({ contextId: royalOakContextId, rank: 1 }),
      });

      const { status, body } = await fetchJson(`${srv.baseUrl}/api/deals`, {
        headers: { cookie: `sid=${sid}` },
      });
      assert.equal(status, 200);
      assert.ok(body.tiers, 'authenticated deals response must include tiers summary');
      assert.equal(body.tiers.watchPreferred >= 1, true,
        'watch-preferred tier should have at least 1 deal (milk at royal oak)');
      assert.equal(body.tiers.watchOther >= 1, true,
        'watch-other tier should have at least 1 deal (milk at chartwell)');

      // All deals should have a tier field
      const allDeals = [...body.historyBacked, ...body.advertised];
      assert.ok(allDeals.every(d => d.tier !== undefined), 'every deal must have a tier field');

      // The first deal in the combined ordering should be the watch-preferred one
      const firstDeal = body.historyBacked[0] || body.advertised[0];
      assert.equal(firstDeal.tier, 'watch-preferred');
      assert.equal(firstDeal.product.id, 'paknsave:milk');
      assert.equal(firstDeal.priceContext.storeId, 'paknsave:royaloak');
    } finally {
      await srv.close();
    }
  });

  it('watch-list product at non-preferred store is in watch-other tier', async () => {
    const srv = await createTestServer({
      records: buildDealsFixture(),
    });
    try {
      const { sid } = await registerAndLogin(srv.baseUrl, 'feeduser3', 'password123');

      // Add milk to watch list but set NO preferred stores
      await fetchJson(`${srv.baseUrl}/api/watch-list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `sid=${sid}` },
        body: JSON.stringify({ targetKind: 'product', targetId: 'paknsave:milk', label: 'Milk' }),
      });

      const { status, body } = await fetchJson(`${srv.baseUrl}/api/deals`, {
        headers: { cookie: `sid=${sid}` },
      });
      assert.equal(status, 200);
      assert.ok(body.tiers);
      assert.equal(body.tiers.watchPreferred, 0, 'no preferred stores → no watch-preferred deals');
      assert.ok(body.tiers.watchOther >= 2, 'both milk deals should be in watch-other');

      const allDeals = [...body.historyBacked, ...body.advertised];
      const milkDeals = allDeals.filter(d => d.product.id === 'paknsave:milk');
      assert.ok(milkDeals.every(d => d.tier === 'watch-other'),
        'all milk deals should be in watch-other tier');
    } finally {
      await srv.close();
    }
  });

  it('non-watched deals are in the all tier', async () => {
    const srv = await createTestServer({ records: buildDealsFixture() });
    try {
      const { sid } = await registerAndLogin(srv.baseUrl, 'feeduser4', 'password123');

      // Watch only butter, no preferred stores
      await fetchJson(`${srv.baseUrl}/api/watch-list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `sid=${sid}` },
        body: JSON.stringify({ targetKind: 'product', targetId: 'paknsave:butter', label: 'Butter' }),
      });

      const { status, body } = await fetchJson(`${srv.baseUrl}/api/deals`, {
        headers: { cookie: `sid=${sid}` },
      });
      assert.equal(status, 200);
      assert.ok(body.tiers);

      const allDeals = [...body.historyBacked, ...body.advertised];
      const nonWatched = allDeals.filter(d => d.product.id !== 'paknsave:butter');
      assert.ok(nonWatched.length > 0, 'should have non-watched deals');
      assert.ok(nonWatched.every(d => d.tier === 'all'),
        'non-watched deals should be in all tier');
    } finally {
      await srv.close();
    }
  });

  it('category watch-list matches deals by category', async () => {
    const srv = await createTestServer({ records: buildDealsFixture() });
    try {
      const { sid } = await registerAndLogin(srv.baseUrl, 'feeduser5', 'password123');

      // Watch the Dairy category — should match both milk and butter
      await fetchJson(`${srv.baseUrl}/api/watch-list`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: `sid=${sid}` },
        body: JSON.stringify({ targetKind: 'category', targetId: 'category:Dairy', label: 'Dairy' }),
      });

      const { status, body } = await fetchJson(`${srv.baseUrl}/api/deals`, {
        headers: { cookie: `sid=${sid}` },
      });
      assert.equal(status, 200);
      assert.ok(body.tiers);

      const allDeals = [...body.historyBacked, ...body.advertised];
      const dairyDeals = allDeals.filter(d => d.product.category === 'Dairy');
      assert.ok(dairyDeals.length > 0, 'should have dairy deals');
      assert.ok(dairyDeals.every(d => d.tier !== 'all'),
        'dairy deals should be in a watch tier, not all');
    } finally {
      await srv.close();
    }
  });

  it('tiers are not included for invalid session (treated as anonymous)', async () => {
    const srv = await createTestServer({ records: buildDealsFixture() });
    try {
      const { status, body } = await fetchJson(`${srv.baseUrl}/api/deals`, {
        headers: { cookie: 'sid=' + '0'.repeat(64) },
      });
      assert.equal(status, 200);
      assert.equal(body.tiers, undefined, 'invalid session should get flat ordering');
    } finally {
      await srv.close();
    }
  });

});
