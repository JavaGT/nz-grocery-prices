import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStaticFallback } from '../../src/app/server.js';
import { Server } from '../../src/server/server.js';
import { AppDatabase } from '../../src/sqlite/app-db.js';
import { Auth } from '../../src/app/auth.js';

// Dist mode: when publicDir holds CONTENT-HASHED assets (tools/build-assets.js
// output), every non-HTML file is served cache-control: immutable and only
// index.html stays no-cache — the browser re-resolves hashed URLs through it.

function createDistStaticServer(distDir) {
  const dbDir = mkdtempSync(join(tmpdir(), 'dist-db-'));
  const appDb = new AppDatabase(join(dbDir, 'app.db'));
  const auth = new Auth(appDb, { clock: () => Date.now() });
  const server = new Server({ appDb, auth });
  server.setFallback(createStaticFallback(distDir, console, { immutableAssets: true }));
  return {
    server, appDb,
    async close() {
      await server.stop();
      try { appDb.close(); } catch {}
      try { rmSync(dbDir, { recursive: true, force: true }); } catch {}
    },
  };
}

describe('static serving in dist mode (content-hashed assets)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dist-static-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.html'), '<html><body>dist SPA</body></html>');
  writeFileSync(join(dir, 'style.0c07360bb2.css'), 'body { color: red; }');
  writeFileSync(join(dir, 'app.ccc68ec70d.js'), 'console.log("dist");');
  writeFileSync(join(dir, 'unhashed-legacy.css'), 'body {}');

  const harness = createDistStaticServer(dir);
  let port;

  it('boots', async () => {
    port = await harness.server.start(0);
    assert.ok(port > 0);
  });

  it('serves hashed assets as immutable', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/style.0c07360bb2.css`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  });

  it('serves unhashed leftovers in dist as immutable too', async () => {
    // Only hashed files + index.html should live in dist in practice; if
    // something unhashed ships there it is still immutable-by-dir policy.
    const res = await fetch(`http://127.0.0.1:${port}/unhashed-legacy.css`);
    assert.equal(res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  });

  it('keeps index.html no-cache so hashed URLs re-resolve', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(res.status, 200);
    assert.ok((await res.text()).includes('dist SPA'));
    assert.equal(res.headers.get('cache-control'), 'no-cache');
  });

  it('still answers 304 conditional requests in dist mode', async () => {
    const first = await fetch(`http://127.0.0.1:${port}/app.ccc68ec70d.js`);
    const etag = first.headers.get('etag');
    assert.ok(etag, 'dist assets carry an etag');
    const second = await fetch(`http://127.0.0.1:${port}/app.ccc68ec70d.js`, {
      headers: { 'if-none-match': etag },
    });
    assert.equal(second.status, 304);
    assert.equal(second.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  });

  after(async () => {
    await harness.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
