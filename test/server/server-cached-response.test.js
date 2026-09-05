import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';
import { request as httpRequest } from 'node:http';
import { CachedResponse, Server } from '../../src/server/server.js';

// Raw HTTP request: undici's fetch auto-decompresses and rewrites
// Accept-Encoding, hiding the wire behavior under test.
function rawRequest(port, path, { method = 'GET', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, method, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

function bigPayload(items) {
  return {
    items: Array.from({ length: items }, (_, i) => ({
      id: `product-${i}`,
      name: `Something Tasty ${i} 500g`,
      retailer: 'newworld',
      currentCents: 499 + i,
      regularCents: 799 + i,
    })),
  };
}

const DECODE = { gzip: gunzipSync, br: brotliDecompressSync };

async function start(server) {
  const port = await server.start(0);
  return { port, stop: () => server.stop() };
}

describe('CachedResponse transport cache', () => {
  it('serves byte-identical JSON semantics with a fresh _requestId per request', async () => {
    const server = new Server({});
    server.get('/api/cached', () => new CachedResponse({
      token: 'v1', body: bigPayload(300), maxAgeMs: 60_000,
    }));
    const srv = await start(server);
    try {
      const res1 = await rawRequest(srv.port, '/api/cached');
      const res2 = await rawRequest(srv.port, '/api/cached');

      assert.equal(res1.headers['content-encoding'], undefined, 'identity encoding: string concat, no compression');
      const b1 = JSON.parse(res1.body.toString());
      const b2 = JSON.parse(res2.body.toString());

      // The payload survives; only the transport-owned _requestId varies.
      assert.deepEqual({ ...b1, _requestId: null }, { ...b2, _requestId: null });
      assert.deepEqual(
        { ...b1, _requestId: null },
        { _requestId: null, _freshness: b1._freshness, ...bigPayload(300) },
      );
      assert.notEqual(b1._requestId, b2._requestId, '_requestId stays per-request');
      assert.equal(b1._requestId, res1.headers['x-request-id']);
      assert.equal(b2._requestId, res2.headers['x-request-id']);
      assert.ok(b1._freshness, '_freshness snapshot present');
    } finally {
      await srv.stop();
    }
  });

  it('reuses encoded bytes: gzip bodies differ only by the per-request prefix member', async () => {
    const server = new Server({});
    server.get('/api/cached', () => new CachedResponse({
      token: 'v1', body: bigPayload(300), maxAgeMs: 60_000,
    }));
    const srv = await start(server);
    try {
      const headers = { 'accept-encoding': 'gzip' };
      await rawRequest(srv.port, '/api/cached', { headers }); // cold: builds cache
      const res2 = await rawRequest(srv.port, '/api/cached', { headers });
      const res3 = await rawRequest(srv.port, '/api/cached', { headers });

      assert.equal(res2.headers['content-encoding'], 'gzip');
      // Multi-member gzip: fresh prefix member + cached tail member decode as one body.
      const d2 = JSON.parse(gunzipSync(res2.body).toString());
      const d3 = JSON.parse(gunzipSync(res3.body).toString());
      assert.equal(res2.body.length, res3.body.length, 'same shape, only the uuid differs');
      assert.notDeepEqual(res2.body, res3.body);
      assert.notEqual(d2._requestId, d3._requestId);
      assert.deepEqual({ ...d2, _requestId: null }, { ...d3, _requestId: null });
    } finally {
      await srv.stop();
    }
  });

  it('br requests decompress to the same JSON as gzip and identity requests', async () => {
    const server = new Server({});
    server.get('/api/cached', () => new CachedResponse({
      token: 'v1', body: bigPayload(300), maxAgeMs: 60_000,
    }));
    const srv = await start(server);
    try {
      const bodies = {};
      for (const enc of ['br', 'gzip', 'none']) {
        const headers = enc === 'none' ? {} : { 'accept-encoding': enc };
        const res = await rawRequest(srv.port, '/api/cached', { headers });
        assert.equal(res.headers['content-encoding'], enc === 'none' ? undefined : enc);
        const text = enc === 'none' ? res.body.toString() : DECODE[enc](res.body).toString();
        bodies[enc] = JSON.parse(text);
      }
      assert.deepEqual(
        { ...bodies.br, _requestId: null },
        { ...bodies.gzip, _requestId: null },
      );
      assert.deepEqual(
        { ...bodies.br, _requestId: null },
        { ...bodies.none, _requestId: null },
      );
    } finally {
      await srv.stop();
    }
  });

  it('keeps security headers and per-request set-cookie on the cached path', async () => {
    const server = new Server({});
    server.get('/api/cached', ctx => {
      ctx.setCookie('sid', 'a'.repeat(64) + '; Path=/; HttpOnly; SameSite=Lax');
      return new CachedResponse({ token: 'v1', body: bigPayload(300), maxAgeMs: 60_000 });
    });
    const srv = await start(server);
    try {
      for (const i of [1, 2]) {
        const res = await rawRequest(srv.port, '/api/cached');
        assert.equal(res.status, 200);
        assert.equal(res.headers['content-type'], 'application/json');
        assert.equal(res.headers['x-content-type-options'], 'nosniff');
        assert.equal(res.headers['x-frame-options'], 'SAMEORIGIN');
        assert.equal(res.headers['referrer-policy'], 'no-referrer');
        assert.equal(res.headers.vary, 'Accept-Encoding');
        assert.match(res.headers['set-cookie'][0], /a{64}/, `request ${i} gets its cookie header`);
        assert.ok(JSON.parse(res.body.toString())._requestId);
      }
    } finally {
      await srv.stop();
    }
  });

  it('expires entries after maxAgeMs and serves the new body (clock-injected)', async () => {
    let nowMs = 1_000_000;
    let generation = 0;
    const server = new Server({ clock: () => nowMs });
    server.get('/api/cached', () => new CachedResponse({
      token: 'v1', body: { gen: ++generation }, maxAgeMs: 5_000,
    }));
    const srv = await start(server);
    try {
      // Tiny body: below MIN_COMPRESS_BYTES it always rides the identity path,
      // which is fine — cache expiry is encoding-independent.
      const r1 = JSON.parse((await rawRequest(srv.port, '/api/cached')).body.toString());
      nowMs += 4_999;
      const r2 = JSON.parse((await rawRequest(srv.port, '/api/cached')).body.toString());
      assert.equal(r1.gen, 1);
      assert.equal(r2.gen, 1, 'within maxAgeMs: cached bytes reused even though the handler produced a newer body');

      nowMs += 2;
      const r3 = JSON.parse((await rawRequest(srv.port, '/api/cached')).body.toString());
      assert.equal(r3.gen, 3, 'after maxAgeMs: entry rebuilt from the current request body');
    } finally {
      await srv.stop();
    }
  });

  it('drops the whole cache at the entry bound without serving wrong bytes', async () => {
    let n = 0;
    const server = new Server({});
    server.get('/api/cached', () => {
      n++;
      return new CachedResponse({ token: 't' + n, body: { n }, maxAgeMs: 60_000 });
    });
    const srv = await start(server);
    try {
      for (let i = 1; i <= 40; i++) {
        const res = await rawRequest(srv.port, '/api/cached');
        assert.equal(JSON.parse(res.body.toString()).n, i, `request ${i} gets its own body`);
      }
    } finally {
      await srv.stop();
    }
  });

  it('falls back to the plain path for reserved keys, arrays, and disabled maxAgeMs', async () => {
    const server = new Server({});
    server.get('/api/reserved', () => new CachedResponse({
      token: 'v1', body: { _freshness: { exists: false }, ok: true }, maxAgeMs: 60_000,
    }));
    server.get('/api/array', () => new CachedResponse({
      token: 'v1', body: [{ ok: true }], maxAgeMs: 60_000,
    }));
    server.get('/api/no-ttl', () => new CachedResponse({
      token: 'v1', body: bigPayload(300), maxAgeMs: 0,
    }));
    const srv = await start(server);
    try {
      const reserved = await rawRequest(srv.port, '/api/reserved');
      assert.equal(reserved.headers['content-encoding'], undefined);
      assert.equal(JSON.parse(reserved.body.toString())._freshness.exists, false, 'handler-owned _freshness respected via plain path');

      const arr = await rawRequest(srv.port, '/api/array');
      assert.equal(reserved.headers['content-encoding'], undefined);
      assert.deepEqual(JSON.parse(arr.body.toString()), [{ ok: true }], 'array bodies serialize bare, as the plain path always has');

      const noTtl = await rawRequest(srv.port, '/api/no-ttl', { headers: { 'accept-encoding': 'gzip' } });
      assert.equal(JSON.parse(gunzipSync(noTtl.body).toString()).items.length, 300);
      assert.equal(noTtl.headers['content-encoding'], 'gzip', 'plain compression still applies');
    } finally {
      await srv.stop();
    }
  });
});

describe('dynamic brotli (plain path)', () => {
  it('prefers brotli when accepted and round-trips', async () => {
    const server = new Server({});
    server.get('/api/large', () => bigPayload(300));
    const srv = await start(server);
    try {
      const res = await rawRequest(srv.port, '/api/large', { headers: { 'accept-encoding': 'br' } });
      assert.equal(res.headers['content-encoding'], 'br');
      assert.equal(res.headers.vary, 'Accept-Encoding');
      assert.equal(JSON.parse(brotliDecompressSync(res.body).toString()).items.length, 300);
    } finally {
      await srv.stop();
    }
  });

  it('falls back to gzip when br is rejected or absent', async () => {
    const server = new Server({});
    server.get('/api/large', () => bigPayload(300));
    const srv = await start(server);
    try {
      const brQ0 = await rawRequest(srv.port, '/api/large', { headers: { 'accept-encoding': 'br;q=0, gzip' } });
      assert.equal(brQ0.headers['content-encoding'], 'gzip');
      const gzipOnly = await rawRequest(srv.port, '/api/large', { headers: { 'accept-encoding': 'gzip' } });
      assert.equal(gzipOnly.headers['content-encoding'], 'gzip');
    } finally {
      await srv.stop();
    }
  });

  it('leaves small bodies uncompressed even when br is accepted', async () => {
    const server = new Server({});
    server.get('/api/small', () => ({ ok: true, note: 'tiny' }));
    const srv = await start(server);
    try {
      const res = await rawRequest(srv.port, '/api/small', { headers: { 'accept-encoding': 'br, gzip' } });
      assert.equal(res.headers['content-encoding'], undefined);
      assert.ok(JSON.parse(res.body.toString()).ok);
    } finally {
      await srv.stop();
    }
  });
});
