import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import workbench, {
  allowAnonymous, entity, number, owner, text, router, serveStatic,
} from 'workbench';
import { PriceArchive } from '../src/archive.js';
import { createObservationRepository } from '../src/archive-factory.js';

/** Prefer full SQLite archive; fall back to legacy JSONL if archive.db missing. */
const defaultArchiveFile = (() => {
  const archiveDb = new URL('../data/archive.db', import.meta.url).pathname;
  const jsonl = new URL('../data/prices.jsonl', import.meta.url).pathname;
  return existsSync(archiveDb) ? archiveDb : jsonl;
})();
const publicDir = new URL('./public', import.meta.url).pathname;
const FEED_OPTIONS = { minDropPercent: 10, baselineDays: 90, freshWithinDays: 7, minSamples: 2 };

/** Cache index.html in memory — read once at startup, never re-read from disk. */
const indexHtml = (() => {
  const indexPath = resolve(publicDir, 'index.html');
  if (!existsSync(indexPath)) return null;
  const content = readFileSync(indexPath);
  return { content, length: Buffer.byteLength(content) };
})();

/** Serve public assets; map bare `/` to cached index.html. */
function servePublicSite(dir) {
  const files = serveStatic(dir, { prefix: '' });
  return (req, res, next) => {
    const pathOnly = String(req.url || '/').split('?')[0];
    if (pathOnly === '/' || pathOnly === '') {
      if (!indexHtml) return next ? next() : res.status(404).end();
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': indexHtml.length,
      });
      return res.end(indexHtml.content);
    }
    return files(req, res, next);
  };
}

const WatchListEntry = entity('WatchListEntry', {
  targetKind: text({
    required: true,
    validate: (value) => ['product', 'category', 'saved-search'].includes(value)
      || 'targetKind must be product, category, or saved-search',
  }),
  targetId: text({ required: true }),
  label: text({ required: true }),
  owner: owner(),
  grant: owner.only,
});

const PreferredStore = entity('PreferredStore', {
  storeId: text({ required: true }),
  storeName: text({ required: true }),
  retailer: text({ required: true }),
  rank: number({
    required: true,
    validate: (value) => (Number.isInteger(value) && value >= 0)
      || 'rank must be a non-negative integer',
  }),
  owner: owner(),
  grant: owner.only,
});

export function priceContextFor(store) {
  const name = store?.name || 'Collected location';
  const contexts = {
    paknsave: { kind: 'physical-store', label: `${name} store price` },
    newworld: { kind: 'physical-store', label: `${name} store price` },
    woolworths: { kind: 'fulfilment-store', label: `${name} pickup/fulfilment price` },
    freshchoice: { kind: 'store-site', label: `${name} store-site price` },
    warehouse: { kind: 'national-online', label: 'The Warehouse national online catalogue price' },
  };
  return contexts[store?.retailer] ?? { kind: 'unknown', label: 'Collected price context' };
}

function imageUrlFrom(images) {
  if (!images) return undefined;
  if (typeof images === 'string') return images;
  if (Array.isArray(images)) {
    for (const item of images) {
      if (typeof item === 'string' && item) return item;
      if (item && typeof item === 'object') {
        const url = item.uri || item.url || item.src || item.primary;
        if (typeof url === 'string' && url) return url;
      }
    }
    return undefined;
  }
  return images.primary || images.big || images.small
    || images['400'] || images['200'] || images['500'] || images['100']
    || Object.values(images).find((value) => typeof value === 'string' && value);
}

function currentCentsFromPrice(price) {
  if (!price || typeof price !== 'object') return undefined;
  if (Number.isFinite(price.promoCents)) return price.promoCents;
  if (Number.isFinite(price.memberCents)) return price.memberCents;
  if (Number.isFinite(price.regularCents)) return price.regularCents;
  if (Number.isFinite(price.currentCents)) return price.currentCents;
  return undefined;
}

function productSummaries(observations) {
  // One row per product×retailer so multi-store Pak'nSave does not hide
  // Woolworths / New World / etc. (Foodstuffs product ids are shared across banners.)
  const byKey = new Map();
  for (const observation of observations) {
    const productId = observation.product?.id;
    if (!productId) continue;
    const retailer = observation.store?.retailer || 'unknown';
    const key = `${productId}\0${retailer}`;
    const existing = byKey.get(key);
    const observedAt = observation.observedAt || observation.lastSeenAt || '';
    if (!existing || observedAt > existing.lastSeen) {
      const cents = currentCentsFromPrice(observation.price);
      byKey.set(key, {
        id: productId,
        name: observation.product.name,
        brand: observation.product.brand,
        categories: observation.product.categories ?? [],
        images: observation.product.images ?? [],
        imageUrl: imageUrlFrom(observation.product.images),
        retailer,
        storeId: observation.store?.id,
        storeName: observation.store?.name,
        priceContext: priceContextFor(observation.store),
        currentCents: cents,
        regularCents: observation.price?.regularCents,
        lastSeen: observedAt,
      });
    }
  }
  return [...byKey.values()];
}

/** Round-robin newest-first across retailers so one chain cannot fill the first page. */
function interleaveByRetailer(products) {
  const buckets = new Map();
  for (const product of products) {
    const key = product.retailer || 'unknown';
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(product);
  }
  for (const list of buckets.values()) {
    list.sort((a, b) => (b.lastSeen || '').localeCompare(a.lastSeen || ''));
  }
  const queues = [...buckets.values()];
  const out = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const queue of queues) {
      if (queue.length) {
        out.push(queue.shift());
        progress = true;
      }
    }
  }
  return out;
}

function historySignalLabel(sale) {
  if (sale.isAllTimeLow) return 'New all-time low';
  if (Number.isFinite(sale.dropPercent) && sale.dropPercent > 0) {
    return `−${Math.round(sale.dropPercent)}% vs recent average`;
  }
  return 'History-backed deal';
}

function shapeHistoryBacked(sale) {
  const store = { retailer: sale.retailer, name: sale.storeName };
  return {
    productId: sale.productId,
    productName: sale.productName,
    brand: sale.brand,
    storeId: sale.storeId,
    storeName: sale.storeName,
    retailer: sale.retailer,
    currentCents: sale.currentCents,
    baselineAverageCents: sale.baselineAverageCents,
    regularCents: sale.baselineAverageCents ?? sale.regularCents,
    dropPercent: sale.dropPercent,
    isAllTimeLow: Boolean(sale.isAllTimeLow),
    observedAt: sale.observedAt,
    signalLabel: historySignalLabel(sale),
    priceContext: priceContextFor(store),
    imageUrl: sale.imageUrl || imageUrlFrom(sale.images),
    promotion: sale.promotion,
    kind: 'history-backed',
  };
}

function shapeAdvertised(sale) {
  const store = { retailer: sale.retailer, name: sale.storeName };
  return {
    productId: sale.productId,
    productName: sale.productName,
    brand: sale.brand,
    storeId: sale.storeId,
    storeName: sale.storeName,
    retailer: sale.retailer,
    currentCents: sale.currentCents,
    regularCents: sale.regularCents,
    savePercent: sale.savePercent,
    isAllTimeLow: false,
    observedAt: sale.observedAt,
    signalLabel: 'Advertised special',
    priceContext: priceContextFor(store),
    imageUrl: sale.imageUrl || imageUrlFrom(sale.images),
    promotion: sale.promotion,
    kind: 'advertised',
  };
}

/**
 * In-process TTL cache over the archive's read paths.
 *
 * Every public endpoint materialises the archive with `archive.history()` /
 * `archive.agentFeed()`, and each of those rebuilds ~370k observation objects
 * from SQLite (~11s of CPU) on every call. The archive.db is rewritten at most
 * once a day by the collector (a separate process), so serving results that are
 * a few minutes stale is safe and turns every repeat navigation from a multi-
 * second full scan into an instant hit. Keying on the pending promise also
 * dedupes concurrent identical scans (e.g. the Deals view fires /deals and
 * /stores at once — both share one history() pass).
 */
export function cachingArchive(archive, {
  ttlMs = Number(process.env.SITE_CACHE_TTL_MS) || 5 * 60_000,
  maxEntries = 32,
} = {}) {
  const cache = new Map(); // key -> { at, value: Promise, refreshing? }
  const store = (key, produce) => {
    const value = Promise.resolve().then(produce);
    cache.set(key, { at: Date.now(), value });
    // Never cache a rejection: a transient DB error must not stick for the TTL.
    value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
    // Bound memory: evict the oldest inserted entry once over capacity.
    if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
    return value;
  };
  const memoize = (key, produce) => {
    const hit = cache.get(key);
    if (!hit) return store(key, produce);
    if (Date.now() - hit.at < ttlMs) return hit.value; // fresh
    // Stale-while-revalidate: serve the last good value immediately and refresh
    // in the background, so no visitor ever blocks on a cold multi-second scan
    // over ~1M offers. Only the very first build (no prior value) awaits.
    if (!hit.refreshing) {
      hit.refreshing = true;
      Promise.resolve().then(produce).then(
        (v) => cache.set(key, { at: Date.now(), value: Promise.resolve(v) }),
        () => { hit.refreshing = false; }, // keep serving stale; a later call retries
      );
    }
    return hit.value;
  };
  return {
    history: (query = {}) => memoize(`history:${JSON.stringify(query)}`, () => archive.history(query)),
    agentFeed: (query = {}) => memoize(`agentFeed:${JSON.stringify(query)}`, () => archive.agentFeed(query)),
    dealsFeed: (query = {}) => memoize(`dealsFeed:${JSON.stringify(query)}`, () => archive.dealsFeed(query)),
    productHistory: (...args) => archive.productHistory?.(...args),
    // Fast read-model methods are cheap; cache anyway so the cold interleave
    // sort / MIN-MAX scan is paid at most once per TTL.
    get fastReads() { return Boolean(archive.fastReads); },
    summary: () => memoize('summary', () => archive.summary()),
    storeList: () => memoize('storeList', () => archive.storeList()),
    productListings: (query = {}) => memoize(`listings:${JSON.stringify(query)}`, () => archive.productListings(query)),
    productImageMap: () => memoize('imageMap', () => archive.productImageMap()),
  };
}

function publicRoutes({ archive }) {
  const api = router();
  const history = async (query = {}) => archive.history(query);

  api.get('/products', allowAnonymous(), async (req, res) => {
    const search = String(req.query.query ?? '').trim().slice(0, 200).toLowerCase();
    const retailer = String(req.query.retailer ?? '').trim().toLowerCase() || undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 42, 1), 500);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    if (archive.fastReads) {
      const page = await archive.productListings({ retailer, query: search, limit, offset });
      const products = page.products.map((product) => ({
        ...product,
        priceContext: priceContextFor({ retailer: product.retailer, name: product.storeName }),
      }));
      res.json({ products, total: page.total, offset: page.offset, limit: page.limit });
      return;
    }

    let products = productSummaries(await history(retailer ? { retailer } : {}))
      .filter((product) => !search || [product.name, product.brand, ...product.categories]
        .filter(Boolean).join(' ').toLowerCase().includes(search));
    products = retailer
      ? products.sort((left, right) => (right.lastSeen || '').localeCompare(left.lastSeen || ''))
      : interleaveByRetailer(products);
    const total = products.length;
    products = products.slice(offset, offset + limit);
    res.json({ products, total, offset, limit });
  });

  api.get('/products/:productId/history', allowAnonymous(), async (req, res) => {
    const productId = decodeURIComponent(req.params.productId);
    const offers = await history({ productId });
    if (offers.length === 0) return res.status(404).json({ error: 'Product not found' });
    const sorted = [...offers].sort((a, b) => (a.observedAt || '').localeCompare(b.observedAt || ''));
    const sparkline = sorted
      .map((offer) => ({
        at: offer.observedAt,
        cents: currentCentsFromPrice(offer.price),
        storeId: offer.store?.id,
      }))
      .filter((point) => Number.isFinite(point.cents));
    const latest = sorted[sorted.length - 1];
    res.json({
      productId,
      product: latest?.product,
      store: latest?.store,
      offers: sorted,
      history: sorted,
      revisions: [],
      sparkline,
      imageUrl: imageUrlFrom(latest?.product?.images),
      freshness: sorted.reduce(
        (latestAt, offer) => (!latestAt || offer.observedAt > latestAt ? offer.observedAt : latestAt),
        null,
      ),
    });
  });

  api.get('/stores', allowAnonymous(), async (_req, res) => {
    if (archive.fastReads) {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({ stores: await archive.storeList() });
      return;
    }
    const stores = new Map();
    for (const observation of await history()) {
      if (observation.store?.id) stores.set(observation.store.id, observation.store);
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({ stores: [...stores.values()] });
  });

  api.get('/stats', allowAnonymous(), async (_req, res) => {
    if (archive.fastReads) {
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json(await archive.summary());
      return;
    }
    const observations = await history();
    const products = new Map();
    const stores = new Map();
    const retailers = new Set();
    let earliest = null;
    let latest = null;
    for (const observation of observations) {
      if (observation.product?.id) products.set(observation.product.id, observation.product);
      if (observation.store?.id) {
        stores.set(observation.store.id, observation.store);
        if (observation.store.retailer) retailers.add(observation.store.retailer);
      }
      const at = observation.observedAt || observation.lastSeenAt;
      if (at) {
        if (!earliest || at < earliest) earliest = at;
        if (!latest || at > latest) latest = at;
      }
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json({
      totalObservations: observations.length,
      totalProducts: products.size,
      totalStores: stores.size,
      stores: [...stores.values()],
      retailers: [...retailers].sort(),
      dateRange: { earliest, latest },
    });
  });

  api.get('/deals', allowAnonymous(), async (_req, res) => {
    // Bounded SQL deal feed on the fast read model; agentFeed only as fallback.
    const feed = archive.fastReads
      ? await archive.dealsFeed(FEED_OPTIONS)
      : await archive.agentFeed(FEED_OPTIONS);
    // Backfill missing deal images from the flat read model (a ~8k-row lookup)
    // instead of re-scanning every offer revision.
    let imageByProduct;
    if (archive.fastReads) {
      imageByProduct = await archive.productImageMap();
    } else {
      imageByProduct = new Map();
      for (const observation of await history()) {
        const id = observation.product?.id;
        if (!id || imageByProduct.has(id)) continue;
        const url = imageUrlFrom(observation.product.images);
        if (url) imageByProduct.set(id, url);
      }
    }
    const withImage = (deal) => (
      deal.imageUrl ? deal : { ...deal, imageUrl: imageByProduct.get(deal.productId) }
    );
    const DEAL_LIMIT = 200;
    const historyBacked = (feed.sales || []).map(shapeHistoryBacked).map(withImage).slice(0, DEAL_LIMIT);
    const advertised = (feed.ongoingSales || []).map(shapeAdvertised).map(withImage).slice(0, DEAL_LIMIT);
    res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=300');
    res.json({
      generatedAt: feed.generatedAt || new Date().toISOString(),
      currency: feed.currency || 'NZD',
      freshWithinDays: FEED_OPTIONS.freshWithinDays,
      historyBacked,
      advertised,
      sales: historyBacked,
      ongoingSales: advertised,
      totals: {
        historyBacked: (feed.sales || []).length,
        advertised: (feed.ongoingSales || []).length,
      },
    });
  });

  return api;
}

export function createGroceryPricesApp({
  archiveFile = process.env.PRICE_ARCHIVE_FILE || defaultArchiveFile,
  archive = new PriceArchive(createObservationRepository(archiveFile)),
  db = process.env.SITE_DB || process.env.PRICES_DB || new URL('./grocery-prices.db', import.meta.url).pathname,
} = {}) {
  const cachedArchive = cachingArchive(archive);
  const app = workbench({ db })
    .auth()
    .mount('/watch-list', WatchListEntry)
    .mount('/preferred-stores', PreferredStore)
    .mount('/api', publicRoutes({ archive: cachedArchive }))
    .use('/', servePublicSite(publicDir));
  // Pre-populate the heavy read-model caches (deal feed + its image map, plus
  // the summary/store aggregates) so the first visitor after boot is served
  // warm instead of paying a multi-second cold scan. Best-effort, non-blocking.
  app.warmCache = async () => {
    if (!cachedArchive.fastReads) return;
    await Promise.allSettled([
      cachedArchive.dealsFeed(FEED_OPTIONS),
      cachedArchive.productImageMap(),
      cachedArchive.summary(),
      cachedArchive.storeList(),
      // Default browse page: matches the cache key /products builds for its
      // first (unfiltered) request, so the landing list is warm too.
      cachedArchive.productListings({ retailer: undefined, query: '', limit: 42, offset: 0 }),
    ]);
  };
  return app;
}

if (import.meta.main) {
  const archiveFile = process.env.PRICE_ARCHIVE_FILE || defaultArchiveFile;
  if (!existsSync(archiveFile)) console.warn(`Price archive not found yet: ${archiveFile}`);
  const port = Number(process.env.PORT) || 7070;
  const app = createGroceryPricesApp({ archiveFile });
  // Warm caches before accepting requests — with materialized deals these
  // are fast indexed queries, so no timeout needed.
  if (app.warmCache) await app.warmCache().catch((err) => console.warn('cache warm failed:', err?.message));
  app.listen(port, {
    rateLimit: {
      ip: { windowMs: 60_000, max: 120 },
      session: { windowMs: 60_000, max: 300 },
    },
    onListening: () => console.log(`Grocery prices → http://localhost:${port}`),
  });
  await app.ready;
}
