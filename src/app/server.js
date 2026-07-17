import { readFileSync, statSync, existsSync } from 'node:fs';
import { extname, join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { ProjectionRepository } from '../sqlite/projection-repository.js';
import { AppDatabase } from '../sqlite/app-db.js';
import { Auth } from './auth.js';
import { Server } from '../server/server.js';
import { createPublicHandlers, defaultQueryDbObservations } from '../server/handlers/public.js';
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

function createStaticFallback(publicDir, logger) {
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

      if (!filePath.startsWith(publicDir)) {
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

        if (process.env.ENABLE_HSTS === '1') {
          headers['strict-transport-security'] = 'max-age=31536000; includeSubDomains';
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
        const indexPath = join(publicDir, 'index.html');
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
      logger.error('[static] Error:', err.message);
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('Internal error');
    }
  };
}

function createAppServer() {
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
  const publicHandlers = createPublicHandlers({ getDb, appDb, auth, clock: Date.now, startedAt: now, queryDbObservations: defaultQueryDbObservations });
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
  server.get('/api/auth/me', privateHandlers.me);
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

  server.setFallback(createStaticFallback(PUBLIC_DIR, console));

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

export { createAppServer, main };
