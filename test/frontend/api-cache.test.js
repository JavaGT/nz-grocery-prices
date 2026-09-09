import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// api.js touches window (auth events) but not the DOM at import time, so the
// cache logic is testable in plain Node with a stubbed fetch.
globalThis.window = { dispatchEvent() {} };

const { api } = await import('../../public/api.js');

function stubFetch(responder) {
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET' });
    return responder(url, opts);
  };
  return calls;
}

const jsonRes = body => ({ ok: true, status: 200, json: async () => body });

describe('api GET cache', () => {
  beforeEach(() => api.clearCache());

  it('serves repeated identical GETs from cache (one fetch)', async () => {
    const calls = stubFetch(() => jsonRes({ items: [1, 2, 3] }));
    const a = await api.deals({ filter: 'all' });
    const b = await api.deals({ filter: 'all' });
    assert.equal(calls.length, 1);
    assert.deepEqual(a, b);
  });

  it('treats different query params as different cache entries', async () => {
    const calls = stubFetch(() => jsonRes({ items: [] }));
    await api.products({ limit: 5 });
    await api.products({ limit: 10 });
    assert.equal(calls.length, 2);
  });

  it('shares concurrent identical GETs instead of refiring', async () => {
    const calls = stubFetch(() => jsonRes({ items: [] }));
    await Promise.all([api.stores(), api.stores(), api.stores()]);
    assert.equal(calls.length, 1);
  });

  it('clears cached reads after a successful mutation', async () => {
    const calls = stubFetch(() => jsonRes({ ok: true }));
    await api.watchlist();
    await api.watchlist(); // cached
    await api.addWatch({ targetId: 'product-1' }); // mutation
    await api.watchlist(); // must hit the network again
    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(c => c.method), ['GET', 'POST', 'GET']);
  });

  it('clears cached reads after a failed mutation too', async () => {
    const calls = stubFetch((url, opts = {}) => {
      if (opts.method === 'DELETE') {
        return { ok: false, status: 500, statusText: 'nope', json: async () => ({}) };
      }
      return jsonRes({ ok: true });
    });
    await api.watchlist();
    await assert.rejects(() => api.removeWatch('e1'));
    await api.watchlist();
    assert.equal(calls.length, 3);
  });

  it('does not cache error responses', async () => {
    let attempts = 0;
    const calls = stubFetch(() => {
      attempts++;
      return attempts === 1
        ? { ok: false, status: 503, statusText: 'down', json: async () => ({}) }
        : jsonRes({ ok: true });
    });
    await assert.rejects(() => api.stores());
    const res = await api.stores();
    assert.ok(res.ok);
    assert.equal(calls.length, 2);
  });

  it('returns a clone of cached data (callers cannot poison the cache)', async () => {
    stubFetch(() => jsonRes({ items: [{ id: 1 }] }));
    const a = await api.deals();
    a.items[0].id = 999;
    const b = await api.deals();
    assert.equal(b.items[0].id, 1);
  });

  it('evicts the oldest entries once the cache exceeds its entry cap (bounded memory)', async () => {
    let seq = 0;
    const calls = stubFetch(() => jsonRes({ seq: ++seq }));
    // > GET_CACHE_MAX_ENTRIES (100): every URL is distinct via the limit param.
    const total = 120;
    for (let i = 0; i < total; i++) await api.products({ limit: i + 1 });
    assert.equal(calls.length, total);

    // The oldest URL (limit=1) was evicted: it must refetch and observe a
    // FRESH value, proving no stale entry survived.
    const refetched = await api.products({ limit: 1 });
    assert.equal(calls.length, total + 1);
    assert.equal(refetched.seq, total + 1);

    // A recently inserted URL is still served from cache.
    await api.products({ limit: total });
    assert.equal(calls.length, total + 1);
  });
});
