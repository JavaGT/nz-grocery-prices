import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { request as httpRequest } from 'node:http';
import { createStaticFallback } from '../../src/app/server.js';
import { Server } from '../../src/server/server.js';
import { AppDatabase } from '../../src/sqlite/app-db.js';
import { Auth } from '../../src/app/auth.js';

async function fetchText(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text };
}

// Raw HTTP request: undici's fetch auto-decompresses gzip/br responses and
// rewrites Accept-Encoding, which hides exactly what these tests assert.
// Returns the untouched wire response.
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

// Uses the REAL createStaticFallback from src/app/server.js so tests exercise
// the same code the production server runs.
function createTestStaticServer(publicDir) {
  const tmp = mkdtempSync(join(tmpdir(), 'static-test-'));
  const staticDir = publicDir || join(tmp, 'public');
  if (!publicDir) {
    mkdirSync(staticDir, { recursive: true });
    writeFileSync(join(staticDir, 'index.html'), '<html><body>SPA</body></html>');
    writeFileSync(join(staticDir, 'style.css'), 'body { color: red; }');
    writeFileSync(join(staticDir, 'app.js'), 'console.log("hello");');
    const subDir = join(staticDir, 'views');
    mkdirSync(subDir);
    writeFileSync(join(subDir, 'deals.js'), 'export function render() {}');
  }

  const dbDir = mkdtempSync(join(tmpdir(), 'static-db-'));
  const appDbPath = join(dbDir, 'app.db');
  const appDb = new AppDatabase(appDbPath);
  const auth = new Auth(appDb, { clock: () => Date.now() });
  const server = new Server({ appDb, auth });

  server.setFallback(createStaticFallback(staticDir, console));

  return {
    server, tmp, staticDir,
    appDb,
    async close() {
      await server.stop();
      try { appDb.close(); } catch {}
      try { rmSync(tmp, { recursive: true, force: true }); } catch {}
      try { rmSync(dbDir, { recursive: true, force: true }); } catch {}
    },
  };
}

describe('static serving', () => {
  it('serves index.html from /', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      const res = await fetchText(`http://127.0.0.1:${port}/`);
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('SPA'));
      assert.equal(res.headers.get('content-type'), 'text/html; charset=utf-8');
    } finally {
      await srv.close();
    }
  });

  it('serves index.html from /index.html', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      const res = await fetchText(`http://127.0.0.1:${port}/index.html`);
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('SPA'));
    } finally {
      await srv.close();
    }
  });

  it('serves CSS with correct MIME type', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      const res = await fetchText(`http://127.0.0.1:${port}/style.css`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'text/css; charset=utf-8');
    } finally {
      await srv.close();
    }
  });

  it('serves JS with correct MIME type', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      const res = await fetchText(`http://127.0.0.1:${port}/app.js`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/javascript; charset=utf-8');
    } finally {
      await srv.close();
    }
  });

  it('serves HEAD request', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      const res = await fetch(`http://127.0.0.1:${port}/style.css`, { method: 'HEAD' });
      assert.equal(res.status, 200);
      assert.ok(res.headers.has('content-length'));
    } finally {
      await srv.close();
    }
  });

  it('cache-control header for non-HTML assets', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      const res = await fetchText(`http://127.0.0.1:${port}/app.js`);
      assert.equal(res.headers.get('cache-control'), 'public, max-age=3600');
    } finally {
      await srv.close();
    }
  });

  it('cache-control header for HTML is no-cache', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      const res = await fetchText(`http://127.0.0.1:${port}/`);
      assert.equal(res.headers.get('cache-control'), 'no-cache');
    } finally {
      await srv.close();
    }
  });

  it('prevents directory traversal', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      const res = await fetchText(`http://127.0.0.1:${port}/safe/%2e%2e%2fpackage.json`);
      assert.ok(res.status === 403 || res.status === 404, 'traversal should be blocked');
    } finally {
      await srv.close();
    }
  });

  it('returns 404 for missing asset (not SPA fallback)', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      const res = await fetchText(`http://127.0.0.1:${port}/missing.js`);
      assert.equal(res.status, 404);
    } finally {
      await srv.close();
    }
  });

  it('returns 404 for /api/ routes not registered', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      const res = await fetchText(`http://127.0.0.1:${port}/api/nonexistent`);
      assert.equal(res.status, 404);
    } finally {
      await srv.close();
    }
  });

  it('SPA fallback for /deals route', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      const res = await fetchText(`http://127.0.0.1:${port}/deals`);
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('SPA'));
    } finally {
      await srv.close();
    }
  });

  it('SPA fallback for /settings route', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      const res = await fetchText(`http://127.0.0.1:${port}/settings`);
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('SPA'));
    } finally {
      await srv.close();
    }
  });

  it('serves files from subdirectory', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      const res = await fetchText(`http://127.0.0.1:${port}/views/deals.js`);
      assert.equal(res.status, 200);
      assert.ok(res.body.includes('render'));
    } finally {
      await srv.close();
    }
  });

  it('x-content-type-options nosniff on static files', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      const res = await fetchText(`http://127.0.0.1:${port}/style.css`);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    } finally {
      await srv.close();
    }
  });

  it('serves null byte in path returns forbidden', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      const res = await fetchText(`http://127.0.0.1:${port}/safe%00`);
      assert.ok(res.status === 403 || res.status === 400, 'null byte should be rejected');
    } finally {
      await srv.close();
    }
  });
});

describe('static compression and conditional requests', () => {
  function writeBigCss(dir) {
    const css = `body { color: red; }\n${Array.from({ length: 200 }, (_, i) => `.rule-${i} { margin: ${i}px; padding: ${i}px; }`).join('\n')}\n`;
    writeFileSync(join(dir, 'style.css'), css);
    return css;
  }

  it('gzips when Accept-Encoding: gzip, with correct decoded body', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      const css = writeBigCss(srv.staticDir);
      const res = await rawRequest(port, '/style.css', { headers: { 'accept-encoding': 'gzip' } });
      assert.equal(res.headers['content-encoding'], 'gzip');
      assert.equal(res.headers.vary, 'Accept-Encoding');
      assert.ok(res.body.length < css.length, `compressed body should be smaller than raw, got ${res.body.length} vs ${css.length}`);
      assert.equal(gunzipSync(res.body).toString(), css);
    } finally {
      await srv.close();
    }
  });

  it('prefers brotli when both brotli and gzip accepted', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      const css = writeBigCss(srv.staticDir);
      const res = await rawRequest(port, '/style.css', { headers: { 'accept-encoding': 'br, gzip' } });
      assert.equal(res.headers['content-encoding'], 'br');
      assert.ok(brotliDecompressSync(res.body).toString() === css);
    } finally {
      await srv.close();
    }
  });

  it('does not set content-encoding when no supported encoding accepted', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      const css = writeBigCss(srv.staticDir);
      const res = await rawRequest(port, '/style.css', { headers: { 'accept-encoding': 'deflate' } });
      assert.equal(res.headers['content-encoding'], undefined);
      assert.equal(res.body.toString(), css);
    } finally {
      await srv.close();
    }
  });

  it('honors q=0 as rejection', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      writeBigCss(srv.staticDir);
      const res = await rawRequest(port, '/style.css', { headers: { 'accept-encoding': 'gzip;q=0, br;q=0.5' } });
      assert.equal(res.headers['content-encoding'], 'br');
    } finally {
      await srv.close();
    }
  });

  it('HEAD reports the encoded content-length without a body', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      writeBigCss(srv.staticDir);
      const res = await rawRequest(port, '/style.css', { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } });
      assert.equal(res.headers['content-encoding'], 'gzip');
      assert.ok(Number(res.headers['content-length']) < writeBigCss(srv.staticDir).length);
      assert.equal(res.body.length, 0);
    } finally {
      await srv.close();
    }
  });

  it('returns 304 for If-None-Match with the served etag, and stays 200 after file change', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      writeBigCss(srv.staticDir);
      const first = await rawRequest(port, '/style.css');
      const etag = first.headers.etag;
      assert.match(etag, /^W\//, 'etag should be weak');

      const notMod = await rawRequest(port, '/style.css', { headers: { 'if-none-match': etag } });
      assert.equal(notMod.status, 304);
      assert.equal(notMod.body.length, 0);

      writeFileSync(join(srv.staticDir, 'style.css'), 'body { color: blue; }\n');
      const changed = await rawRequest(port, '/style.css', { headers: { 'if-none-match': etag } });
      assert.equal(changed.status, 200, 'mtime change must invalidate the etag');
      assert.equal(changed.body.toString(), 'body { color: blue; }\n');
    } finally {
      await srv.close();
    }
  });

  it('matches etag weakly (W/ prefix ignored on comparison)', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      writeBigCss(srv.staticDir);
      const first = await rawRequest(port, '/style.css');
      // strip W/ and surrounding quotes -> send back a strong-looking etag
      const opaque = first.headers.etag.replace(/^W\//, '').replace(/"/g, '');
      const res = await rawRequest(port, '/style.css', { headers: { 'if-none-match': `"${opaque}"` } });
      assert.equal(res.status, 304);
    } finally {
      await srv.close();
    }
  });

  it('does not compress files below the 256B threshold but still serves them', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      // default style.css is 19 bytes
      const res = await rawRequest(port, '/style.css', { headers: { 'accept-encoding': 'gzip, br' } });
      assert.equal(res.headers['content-encoding'], undefined);
      assert.equal(res.headers.vary, 'Accept-Encoding');
      assert.equal(res.body.toString(), 'body { color: red; }');
    } finally {
      await srv.close();
    }
  });

  it('serves compressible repeated requests from the memory cache (stable content, no disk churn symptom)', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      writeBigCss(srv.staticDir);
      const a = await rawRequest(port, '/style.css', { headers: { 'accept-encoding': 'gzip' } });
      const b = await rawRequest(port, '/style.css', { headers: { 'accept-encoding': 'gzip' } });
      assert.equal(a.body.length, b.body.length);
      assert.equal(a.headers.etag, b.headers.etag);
    } finally {
      await srv.close();
    }
  });

  it('SPA fallback serves index.html with etag and compression', async () => {
    const srv = createTestStaticServer();
    try {
      const port = await srv.server.start(0);
      // pad index.html over the compression threshold
      writeFileSync(join(srv.staticDir, 'index.html'), `<html><body>SPA ${'x'.repeat(400)}</body></html>`);
      const res = await rawRequest(port, '/deals', { headers: { 'accept-encoding': 'gzip' } });
      assert.equal(res.status, 200);
      assert.equal(res.headers['content-encoding'], 'gzip');
      assert.equal(res.headers['cache-control'], 'no-cache');
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.ok(gunzipSync(res.body).toString().includes('SPA'));
    } finally {
      await srv.close();
    }
  });
});
