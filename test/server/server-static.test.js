import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPublicHandlers } from '../../src/server/handlers/public.js';
import { createPrivateHandlers } from '../../src/server/handlers/private.js';
import { Server } from '../../src/server/server.js';
import { AppDatabase } from '../../src/sqlite/app-db.js';
import { Auth } from '../../src/app/auth.js';

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const SPNA_FALLBACK_ROUTES = ['/deals', '/browse', '/watchlist', '/saved', '/settings'];

function isNavigationRoute(pathname) {
  if (pathname === '/') return true;
  return SPNA_FALLBACK_ROUTES.some(r => pathname === r || pathname.startsWith(r + '/'));
}

async function fetchText(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text };
}

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

  server.setFallback((req, res, pathname, requestId) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      let filePathname = decodeURIComponent(url.pathname);

      if (filePathname === '/' || filePathname === '') {
        filePathname = '/index.html';
      }

      if (filePathname.includes('..') || filePathname.includes('\0')) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      const filePath = join(staticDir, filePathname);

      if (!filePath.startsWith(staticDir)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      if (existsSync(filePath) && statSync(filePath).isFile()) {
        const ext = extname(filePath).toLowerCase();
        const mime = MIME_TYPES[ext] || 'application/octet-stream';
        const isCacheable = ext !== '.html';
        const content = readFileSync(filePath);

        const headers = {
          'content-type': mime,
          'x-content-type-options': 'nosniff',
        };

        if (isCacheable) {
          headers['cache-control'] = 'public, max-age=3600';
        } else {
          headers['cache-control'] = 'no-cache';
        }

        if (req.method === 'HEAD') {
          headers['content-length'] = content.length;
          res.writeHead(200, headers);
          res.end();
          return;
        }

        res.writeHead(200, headers);
        res.end(content);
        return;
      }

      if (isNavigationRoute(filePathname)) {
        const indexPath = join(staticDir, 'index.html');
        if (existsSync(indexPath)) {
          const content = readFileSync(indexPath);
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-cache',
          });
          res.end(content);
          return;
        }
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Internal error');
    }
  });

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
