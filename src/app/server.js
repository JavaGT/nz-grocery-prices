import { readFileSync, statSync, existsSync } from 'node:fs';
import { extname, join, dirname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, brotliCompressSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { ProjectionRepository } from '../sqlite/projection-repository.js';
import { AppDatabase } from '../sqlite/app-db.js';
import { Auth } from './auth.js';
import { Server, parseAcceptEncoding } from '../server/server.js';
import { createPublicHandlers } from '../server/handlers/public.js';
import { createPrivateHandlers } from '../server/handlers/private.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(HERE, '..', '..', 'public');
const DATA_DIR = join(HERE, '..', '..', 'data');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
};

const SPNA_FALLBACK_ROUTES = ['/deals', '/browse', '/watchlist', '/saved', '/settings'];

function isNavigationRoute(pathname) {
  if (pathname === '/') return true;
  return SPNA_FALLBACK_ROUTES.some(r => pathname === r || pathname.startsWith(r + '/'));
}

const COMPRESSIBLE_EXTS = new Set(['.html', '.css', '.js', '.json', '.svg', '.map', '.txt']);
// Below ~256 bytes gzip/brotli rarely beat the transfer of the raw body once
// headers are counted; skip encoding for tiny files.
const MIN_COMPRESS_BYTES = 256;

// Per-fallback in-memory cache: absolute path -> { mtimeMs, size, content,
// etag, compressible, encodings }. Encoded variants (gzip/brotli) are computed
// lazily on first request and reused; entries are invalidated when the file's
// mtime or size changes (checked via one statSync per request, so an updated
// file is picked up without a server restart).
function createStaticFallback(publicDir, logger, { immutableAssets = false } = {}) {
  // In dist mode every non-HTML file is content-hashed, so it can be cached
  // forever; index.html stays no-cache and re-resolves the hashed URLs.
  const assetCacheControl = immutableAssets
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=3600';
  const fileCache = new Map();

  function loadCached(filePath, stat, ext) {
    const cached = fileCache.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return cached;
    }
    const entry = {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      content: readFileSync(filePath),
      etag: `W/"${stat.size.toString(36)}-${Math.round(stat.mtimeMs).toString(36)}"`,
      compressible: COMPRESSIBLE_EXTS.has(ext),
      encodings: new Map(),
    };
    // Dist builds (tools/build-assets.js) ship precompressed .br/.gz siblings
    // computed at max quality; prefer them so the first request for an asset
    // pays no compression latency. Absent sidecars (dev public/, or files
    // placed in dist by hand) fall back to lazy compression below.
    if (immutableAssets && entry.compressible && entry.size >= MIN_COMPRESS_BYTES) {
      for (const [encoding, suffix] of [['br', '.br'], ['gzip', '.gz']]) {
        try {
          const sidecar = readFileSync(filePath + suffix);
          if (sidecar.length > 0) entry.encodings.set(encoding, sidecar);
        } catch {}
      }
    }
    fileCache.set(filePath, entry);
    return entry;
  }

  // Returns the encoded body for the entry, or null when the encoding is not
  // worthwhile (non-compressible type or file below the threshold).
  function encodedVariant(entry, encoding) {
    if (!entry.encodings.has(encoding)) {
      let buf = null;
      if (entry.compressible && entry.size >= MIN_COMPRESS_BYTES) {
        try {
          buf = encoding === 'br'
            ? brotliCompressSync(entry.content)
            : gzipSync(entry.content);
        } catch (err) {
          logger.error(`[static] ${encoding} compression failed:`, err.message);
        }
      }
      entry.encodings.set(encoding, buf);
    }
    return entry.encodings.get(encoding);
  }

  function serveFile(req, res, filePath, ext) {
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      return false;
    }
    if (!stat.isFile()) return false;

    const entry = loadCached(filePath, stat, ext);

    // Weak comparison (RFC 9110 8.8.3.2): compare opaque tags, ignoring W/.
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch) {
      const matches = ifNoneMatch.split(',').some(raw => {
        const tag = raw.trim().replace(/^W\//, '');
        return tag === entry.etag.replace(/^W\//, '') || tag === '*';
      });
      if (matches) {
        res.writeHead(304, {
          etag: entry.etag,
          'cache-control': ext === '.html' ? 'no-cache' : assetCacheControl,
          vary: 'Accept-Encoding',
        });
        res.end();
        return true;
      }
    }

    let body = entry.content;
    const headers = {
      'content-type': MIME_TYPES[ext] || 'application/octet-stream',
      'x-content-type-options': 'nosniff',
      etag: entry.etag,
      'cache-control': ext === '.html' ? 'no-cache' : assetCacheControl,
    };

    if (entry.compressible) {
      headers.vary = 'Accept-Encoding';
      const accepted = parseAcceptEncoding(req.headers['accept-encoding']);
      // Prefer brotli (measured ~3% smaller than gzip on this payload);
      // both variants are cached so the cost is one-time per file version.
      if (accepted.br > 0) {
        const br = encodedVariant(entry, 'br');
        if (br) { body = br; headers['content-encoding'] = 'br'; }
      } else if (accepted.gzip > 0) {
        const gz = encodedVariant(entry, 'gzip');
        if (gz) { body = gz; headers['content-encoding'] = 'gzip'; }
      }
    }

    if (process.env.ENABLE_HSTS === '1') {
      headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
    }

    headers['content-length'] = body.length;
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
    return true;
  }

  return (req, res, pathname, requestId) => {
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

      const filePath = join(publicDir, filePathname);

      if (!filePath.startsWith(publicDir + sep)) {
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('Forbidden');
        return;
      }

      const ext = extname(filePath).toLowerCase();
      if (serveFile(req, res, filePath, ext)) return;

      if (isNavigationRoute(filePathname)) {
        const indexPath = join(publicDir, 'index.html');
        if (serveFile(req, res, indexPath, '.html')) return;
      }

      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('Not found');
    } catch (err) {
      logger.error('[static] Error:', err.message);
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Internal error');
    }
  };
}

function createAppServer() {
  // Prefer the content-hashed build output (tools/build-assets.js -> npm run
  // build:assets) when it has been generated; fall back to public/ for dev.
  const distDir = join(HERE, '..', '..', 'public-dist');
  const publicDir = existsSync(distDir) ? distDir : join(HERE, '..', '..', 'public');
  const immutableAssets = publicDir === distDir;
  const pricesDbPath = process.env.PRICES_DB || join(DATA_DIR, 'prices.db');
  const appDbPath = process.env.APP_DB || join(DATA_DIR, 'app.db');
  const jsonlPath = process.env.JSONL_PATH || join(DATA_DIR, 'prices.jsonl');

  let projDb = null;
  let projDbRef = null;

  function getDb() { return projDbRef; }

  const appDb = new AppDatabase(appDbPath);

  if (existsSync(pricesDbPath)) {
    try {
      projDb = new DatabaseSync(pricesDbPath, { readOnly: true });
      projDbRef = projDb;
    } catch (err) {
      console.error('[server] Failed to open projection DB, serving degraded:', err.message);
    }
  } else {
    console.warn('[server] prices.db not found, attempting rebuild...');
    try {
      const repo = new ProjectionRepository(jsonlPath, pricesDbPath);
      repo.rebuild({ force: false });
      repo.close();
      projDb = new DatabaseSync(pricesDbPath, { readOnly: true });
      projDbRef = projDb;
    } catch (err) {
      console.error('[server] Rebuild failed, serving degraded:', err.message);
    }
  }

  const auth = new Auth(appDb, { clock: () => Date.now() });
  const server = new Server({ projDb, appDb, auth });
  const now = Date.now();
  // Cheap change probe for the deals cache: when the projection is rebuilt
  // (file replaced on disk), the cache drops immediately instead of waiting
  // out the TTL. Note the read-only connection keeps serving the old inode
  // until restart; the probe just avoids compounding that with cache lag.
  const dbSignature = () => {
    try { return statSync(pricesDbPath).mtimeMs; } catch { return null; }
  };
  const publicHandlers = createPublicHandlers({ getDb, appDb, auth, clock: Date.now, startedAt: now, dbSignature });
  const privateHandlers = createPrivateHandlers({ auth, appDb, clock: Date.now });

  server.get('/api/health', publicHandlers.health);
  server.get('/api/products', publicHandlers.listProducts);
  server.get('/api/products/:productId', publicHandlers.getProduct);
  server.get('/api/products/:productId/history', publicHandlers.getProductHistory);
  server.get('/api/stores', publicHandlers.listStores);
  server.get('/api/search/suggestions', publicHandlers.searchSuggestions);
  server.get('/api/deals', publicHandlers.listDeals);

  server.post('/api/auth/register', privateHandlers.register);
  server.post('/api/auth/login', privateHandlers.login);
  server.post('/api/auth/logout', privateHandlers.logout);
  server.get('/api/watch-list', privateHandlers.getWatchList);
  server.post('/api/watch-list', privateHandlers.addWatchList);
  server.delete('/api/watch-list/:entryId', privateHandlers.deleteWatchList);
  server.get('/api/preferred-stores', privateHandlers.getPreferredStores);
  server.post('/api/preferred-stores', privateHandlers.setPreferredStore);
  server.delete('/api/preferred-stores/:contextId', privateHandlers.deletePreferredStore);
  server.get('/api/saved-searches', privateHandlers.getSavedSearches);
  server.post('/api/saved-searches', privateHandlers.createSavedSearch);
  server.delete('/api/saved-searches/:searchId', privateHandlers.deleteSavedSearch);
  server.get('/api/new-products', privateHandlers.getNewProducts);

  server.setFallback(createStaticFallback(publicDir, console, { immutableAssets }));
  console.log(`[server] static assets: ${publicDir === distDir ? 'public-dist (immutable, content-hashed)' : 'public (dev mode)'}`);

  return { server, appDb, projDb };
}

function main() {
  const host = process.env.HOST || '127.0.0.1';
  const port = parseInt(process.env.PORT || '3010', 10);

  const app = createAppServer();

  app.server.start(port).then(actualPort => {
    console.log(`[server] price·minder listening on http://${host}:${actualPort}`);
  });

  const shutdown = () => {
    console.log('[server] Shutting down...');
    app.server.stop().then(() => {
      try { app.appDb.close(); } catch {}
      try { app.projDb?.close(); } catch {}
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main();
}

export { createAppServer, main, createStaticFallback };
