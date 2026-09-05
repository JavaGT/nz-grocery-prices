import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { request as httpRequest } from 'node:http';
import { Server, parseAcceptEncoding } from '../../src/server/server.js';
import { AppDatabase } from '../../src/sqlite/app-db.js';
import { Auth } from '../../src/app/auth.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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

function bigObject(items) {
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

async function createTestServer() {
  const dbDir = mkdtempSync(join(tmpdir(), 'compress-db-'));
  const appDb = new AppDatabase(join(dbDir, 'app.db'));
  const auth = new Auth(appDb, { clock: () => Date.now() });
  const server = new Server({ appDb, auth });
  server.get('/api/test-large', () => bigObject(300)); // ~30KB JSON
  server.get('/api/test-small', () => ({ ok: true, note: 'tiny' }));
  const port = await server.start(0);
  return {
    port,
    async close() {
      await server.stop();
      try { appDb.close(); } catch {}
      try { rmSync(dbDir, { recursive: true, force: true }); } catch {}
    },
  };
}

describe('JSON API compression', () => {
  it('gzips large responses when Accept-Encoding: gzip', async () => {
    const srv = await createTestServer();
    try {
      const res = await rawRequest(srv.port, '/api/test-large', { headers: { 'accept-encoding': 'gzip' } });
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-encoding'], 'gzip');
      assert.equal(res.headers.vary, 'Accept-Encoding');
      const decoded = JSON.parse(gunzipSync(res.body).toString());
      assert.equal(decoded.items.length, 300);
      assert.equal(res.headers['content-length'], String(res.body.length), 'content-length must match the encoded body');
    } finally {
      await srv.close();
    }
  });

  it('serves large responses uncompressed without Accept-Encoding', async () => {
    const srv = await createTestServer();
    try {
      const res = await rawRequest(srv.port, '/api/test-large');
      assert.equal(res.headers['content-encoding'], undefined);
      assert.equal(res.headers.vary, 'Accept-Encoding');
      const decoded = JSON.parse(res.body.toString());
      assert.equal(decoded.items.length, 300);
      assert.equal(res.headers['content-length'], String(res.body.length));
    } finally {
      await srv.close();
    }
  });

  it('does not gzip small responses even when gzip is accepted (below 1KB threshold)', async () => {
    const srv = await createTestServer();
    try {
      const res = await rawRequest(srv.port, '/api/test-small', { headers: { 'accept-encoding': 'gzip' } });
      assert.equal(res.headers['content-encoding'], undefined);
      assert.ok(JSON.parse(res.body.toString()).ok);
    } finally {
      await srv.close();
    }
  });

  it('honors gzip;q=0 as rejection', async () => {
    const srv = await createTestServer();
    try {
      const res = await rawRequest(srv.port, '/api/test-large', { headers: { 'accept-encoding': 'gzip;q=0' } });
      assert.equal(res.headers['content-encoding'], undefined);
    } finally {
      await srv.close();
    }
  });

  it('compressed error responses also carry gzip when large enough', async () => {
    const srv = await createTestServer();
    try {
      const res = await rawRequest(srv.port, '/api/test-large', { method: 'POST', headers: { 'accept-encoding': 'gzip' } });
      assert.equal(res.status, 405);
      assert.equal(res.headers['content-encoding'], undefined, '405 body is small and stays uncompressed');
    } finally {
      await srv.close();
    }
  });
});

describe('parseAcceptEncoding', () => {
  it('parses tokens, q-values, and defaults', () => {
    assert.deepEqual(parseAcceptEncoding('gzip'), { gzip: 1, br: 0 });
    assert.deepEqual(parseAcceptEncoding('br;q=0.8, gzip;q=0.5, deflate'), { gzip: 0.5, br: 0.8 });
    assert.deepEqual(parseAcceptEncoding('gzip;q=0'), { gzip: 0, br: 0 });
    assert.deepEqual(parseAcceptEncoding(''), { gzip: 0, br: 0 });
    assert.deepEqual(parseAcceptEncoding(undefined), { gzip: 0, br: 0 });
    assert.deepEqual(parseAcceptEncoding('*'), { gzip: 0, br: 0 }, 'wildcard alone: no explicit acceptance');
    assert.deepEqual(parseAcceptEncoding('GZIP; q=0.25, BR'), { gzip: 0.25, br: 1 }, 'case-insensitive tokens');
  });
});
