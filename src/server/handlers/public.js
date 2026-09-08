import { StatusError, CachedResponse } from '../server.js';

const PRODUCT_ID_RE = /^[a-z]+:[a-zA-Z0-9_-]+$/;

const RETAILER_DISPLAY = {
  paknsave: "PAK'nSAVE",
  newworld: 'New World',
  woolworths: 'Woolworths',
  freshchoice: 'FreshChoice',
  warehouse: 'The Warehouse',
};

function retailerName(id) {
  return RETAILER_DISPLAY[id] || id;
}

function clamp(v, min, max, def) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? Math.floor(n) : def;
}

const TIER_WATCH_PREFERRED = 'watch-preferred';
const TIER_WATCH_OTHER = 'watch-other';
const TIER_ALL = 'all';

const DEFAULT_DEALS_CACHE_TTL_MS = 5 * 60 * 1000;

function defaultDealsCacheTtlMs() {
  const n = Number(process.env.DEALS_CACHE_TTL_MS);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DEALS_CACHE_TTL_MS;
}

export function defaultQueryDealSignals(db, retailer) {
  return db.prepare(`
    SELECT ds.product_id, ds.signal_kind, ds.reference_cents, ds.current_cents,
           ds.drop_percent, ds.calculated_at, ds.price_policy,
           p.name AS product_name, p.brand AS product_brand,
           p.category AS product_category, p.image_url AS product_image,
           pc.retailer_id, pc.store_id, pc.store_name
    FROM deal_signals ds
    JOIN products p ON p.id = ds.product_id
    JOIN price_contexts pc ON pc.id = ds.context_id
    ${retailer ? 'WHERE pc.retailer_id = ?' : ''}
  `).all(...(retailer ? [retailer] : []));
}

export function createPublicHandlers({ getDb, appDb, auth, clock, startedAt, queryDealSignals, dealsCacheTtlMs = defaultDealsCacheTtlMs(), dbSignature }) {
  function db() {
    const d = typeof getDb === 'function' ? getDb() : getDb;
    if (!d) throw new StatusError(503, 'SERVICE_UNAVAILABLE', 'Projection database not available');
    return d;
  }

  function resolveUser(ctx) {
    if (!auth || !appDb || !ctx.cookies?.sid) return null;
    return auth.getSessionUser(ctx.cookies.sid);
  }

  function loadUserTiers(ctx) {
    const user = resolveUser(ctx);
    if (!user) return null;

    const watchEntries = appDb.getWatchList(user.id);
    const watchProductIds = new Set();
    const watchCategories = new Set();
    for (const entry of watchEntries) {
      if (entry.target_kind === 'product') watchProductIds.add(entry.target_id);
      else if (entry.target_kind === 'category') {
        const cat = entry.target_id.includes(':')
          ? entry.target_id.split(':').slice(1).join(':')
          : entry.target_id;
        watchCategories.add(cat);
      }
    }

    const prefRows = appDb.getStorePreferences(user.id);
    let preferredStoreIds = new Set();
    if (prefRows.length > 0) {
      const contextIds = prefRows.map(r => r.context_id);
      const placeholders = contextIds.map(() => '?').join(',');
      const rows = db().prepare(
        `SELECT store_id FROM price_contexts WHERE id IN (${placeholders})`
      ).all(...contextIds);
      preferredStoreIds = new Set(rows.map(r => r.store_id));
    }

    return { user, watchProductIds, watchCategories, preferredStoreIds };
  }

  function dealTier(deal, tiers) {
    if (!tiers) return TIER_ALL;
    const isWatched = tiers.watchProductIds.has(deal.product.id) ||
      (deal.product.category && tiers.watchCategories.has(deal.product.category));
    if (!isWatched) return TIER_ALL;
    return tiers.preferredStoreIds.has(deal.priceContext.storeId)
      ? TIER_WATCH_PREFERRED
      : TIER_WATCH_OTHER;
  }

  function productDetail(productId) {
    return db().prepare(`
      SELECT id, retailer_id, name, brand, category, image_url, size,
             source_id, gtin, first_seen_at, updated_at
      FROM products WHERE id = ?
    `).get(productId);
  }

  function formatProduct(row) {
    return {
      id: row.id,
      retailerId: row.retailer_id,
      retailerName: retailerName(row.retailer_id),
      name: row.name,
      brand: row.brand || null,
      category: row.category || null,
      imageUrl: row.image_url || null,
      size: row.size || null,
      sourceId: row.source_id || null,
      gtin: row.gtin || null,
      firstSeenAt: row.first_seen_at ? new Date(row.first_seen_at).toISOString() : null,
      updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
  }

  async function health(ctx) {
    // Reuse the per-request projection snapshot the Server already took for
    // the response envelope instead of re-reading `_meta` a third time. The
    // fallback covers direct handler calls with a bare ctx (unit tests).
    const f = ctx.freshness || { exists: false, fingerprint: null, builtAt: null, recordsImported: 0 };

    return {
      status: f.exists ? 'ok' : 'degraded',
      startedAt: new Date(startedAt).toISOString(),
      uptime: ctx.clock() - startedAt,
      projection: {
        exists: f.exists,
        fingerprint: f.fingerprint,
        builtAt: f.builtAt,
        recordsImported: f.recordsImported,
      },
    };
  }

  async function listProducts(ctx) {
    db();
    const q = (ctx.query.query || '').trim();
    if (q.length > 200) {
      throw new StatusError(400, 'QUERY_TOO_LONG', 'Search query must be 200 characters or fewer');
    }

    const retailer = (ctx.query.retailer || '').trim();
    const limit = clamp(ctx.query.limit, 1, 200, 42);
    const offset = clamp(ctx.query.offset, 0, Infinity, 0);

    const params = [];
    const where = [];

    if (q) {
      where.push('name LIKE ? COLLATE NOCASE');
      params.push(`%${q.replace(/[%_]/g, '\\$&')}%`);
    }

    if (retailer) {
      where.push('retailer_id = ?');
      params.push(retailer);
    }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
    const orderClause = q
      ? `ORDER BY CASE WHEN name = ? THEN 0 WHEN name LIKE ? THEN 1 ELSE 2 END, updated_at DESC`
      : 'ORDER BY updated_at DESC';

    const orderParams = q ? [q, `%${q}%`] : [];
    // Explicit columns, not SELECT *: formatProduct never reads latest_hash,
    // and at archive scale dragging it across every listing row is pure waste.
    const columns = `
      id, retailer_id, name, brand, category, image_url, size,
      source_id, gtin, first_seen_at, updated_at
    `;

    let total;
    let rows;
    if (whereClause) {
      // Filtered search runs the LIKE scan ONCE: the page query carries the
      // total as a COUNT(*) OVER () window value instead of paying a second
      // full COUNT scan (measured ~0.4 ms of the ~1.2 ms SQL per search at
      // archive scale; identical rows, order, and total — see
      // perf-notes/REPORT-spa.md).
      rows = db().prepare(`
        SELECT ${columns}, COUNT(*) OVER () AS _total
        FROM products ${whereClause} ${orderClause} LIMIT ? OFFSET ?
      `).all(...params, ...orderParams, limit, offset);
      // A page past the end returns no rows and no window value, so that
      // case falls back to the standalone count to keep `total` exact.
      total = rows.length > 0
        ? rows[0]._total
        : (db().prepare(`SELECT COUNT(*) AS c FROM products ${whereClause}`).get(...params)?.c ?? 0);
    } else {
      // Unfiltered listing keeps the separate COUNT(*): the window version
      // would force SQLite to materialize every row before LIMIT, while a
      // plain COUNT(*) rides the covering name index.
      const countRow = db().prepare('SELECT COUNT(*) AS c FROM products').get();
      total = countRow ? countRow.c : 0;
      rows = db().prepare(`
        SELECT ${columns}
        FROM products ${orderClause} LIMIT ? OFFSET ?
      `).all(...params, ...orderParams, limit, offset);
    }

    return { products: rows.map(formatProduct), total, limit, offset };
  }

  async function getProduct(ctx) {
    db();
    const productId = ctx.params.productId;
    if (!PRODUCT_ID_RE.test(productId)) {
      throw new StatusError(400, 'INVALID_PRODUCT_ID', 'Product ID must match pattern retailer:id');
    }

    const productRow = productDetail(productId);
    if (!productRow) {
      throw new StatusError(404, 'PRODUCT_NOT_FOUND', `Product ${productId} not found`);
    }

    // Column audit: promotion_data and source_data are NOT read by the offer
    // mapping below — selecting them materializes large JSON blobs per offer
    // on the product-detail path for nothing. The columns stay in the schema
    // (rebuild/materialization still writes them).
    const offers = db().prepare(`
      SELECT or2.offer_key, or2.context_id, or2.price_regular_cents, or2.price_promo_cents,
             or2.price_member_cents, or2.comparative, or2.observed_at,
             pc.store_id, pc.store_name, pc.scope_kind,
             r.id AS retailer_id, r.name AS retailer_name
      FROM offer_revisions or2
      JOIN price_contexts pc ON pc.id = or2.context_id
      JOIN retailers r ON r.id = pc.retailer_id
      WHERE or2.product_id = ?
        AND or2.observed_at = (
          SELECT MAX(observed_at) FROM offer_revisions
          WHERE product_id = ? AND context_id = or2.context_id
        )
      ORDER BY or2.observed_at DESC
    `).all(productId, productId);

    function retailerFromId(pid) { return pid.split(':')[0]; }

    let matches = [];
    let candidates = [];

    if (appDb) {
      const allPairs = typeof appDb.getMatchesForProduct === 'function'
        ? appDb.getMatchesForProduct(productId)
        : [];
      matches = allPairs
        .filter(p => p.review_state === 'confirmed')
        .map(p => ({
          productIdA: p.product_a_id,
          retailerA: retailerFromId(p.product_a_id),
          productIdB: p.product_b_id,
          retailerB: retailerFromId(p.product_b_id),
          method: p.match_method,
          confidence: p.confidence,
          reviewState: p.review_state,
        }));
      candidates = allPairs
        .filter(p => p.review_state === 'candidate')
        .map(p => ({
          productIdA: p.product_a_id,
          retailerA: retailerFromId(p.product_a_id),
          productIdB: p.product_b_id,
          retailerB: retailerFromId(p.product_b_id),
          method: p.match_method,
          confidence: p.confidence,
          reviewState: p.review_state,
        }));
    }

    return {
      product: formatProduct(productRow),
      offers: offers.map(o => ({
        offerKey: o.offer_key,
        priceContext: {
          retailerId: o.retailer_id,
          retailerName: o.retailer_name,
          storeId: o.store_id,
          storeName: o.store_name,
          scopeKind: o.scope_kind,
        },
        cents: {
          regular: o.price_regular_cents,
          promo: o.price_promo_cents,
          member: o.price_member_cents,
        },
        comparative: o.comparative ? JSON.parse(o.comparative) : null,
        isOnSpecial: false,
        lastSeenAt: new Date(o.observed_at).toISOString(),
        historyUrl: `/api/products/${productId}/history?context=${o.context_id}`,
      })),
      matches,
      candidates,
    };
  }

  async function getProductHistory(ctx) {
    db();
    const productId = ctx.params.productId;
    if (!PRODUCT_ID_RE.test(productId)) {
      throw new StatusError(400, 'INVALID_PRODUCT_ID', 'Product ID must match pattern retailer:id');
    }

    const productRow = productDetail(productId);
    if (!productRow) {
      throw new StatusError(404, 'PRODUCT_NOT_FOUND', `Product ${productId} not found`);
    }

    // Column audit: source_data is never read by the history mapping — the
    // biggest JSON blob per row, skipped on purpose. The column remains in
    // the schema for the rebuild/materialization path.
    const rows = db().prepare(`
      SELECT offer_key, context_id, product_id, price_regular_cents, price_promo_cents,
             price_member_cents, comparative, promotion_data, observed_at
      FROM offer_revisions
      WHERE product_id = ?
      ORDER BY observed_at DESC
      LIMIT 200
    `).all(productId);

    return {
      product: formatProduct(productRow),
      history: rows.map(r => ({
        offerKey: r.offer_key,
        contextId: r.context_id,
        cents: { regular: r.price_regular_cents, promo: r.price_promo_cents, member: r.price_member_cents },
        comparative: r.comparative ? JSON.parse(r.comparative) : null,
        promotion: r.promotion_data ? JSON.parse(r.promotion_data) : null,
        observedAt: new Date(r.observed_at).toISOString(),
      })),
    };
  }

  async function listStores(ctx) {
    db();
    const rows = db().prepare(`
      SELECT pc.id, pc.retailer_id, pc.store_id, pc.store_name, pc.scope_kind,
             pc.address, pc.region, r.name AS retailer_name
      FROM price_contexts pc
      JOIN retailers r ON r.id = pc.retailer_id
      ORDER BY r.name, pc.store_name
    `).all();

    return {
      stores: rows.map(r => ({
        id: r.id,
        retailerId: r.retailer_id,
        retailerName: r.retailer_name,
        storeId: r.store_id,
        storeName: r.store_name,
        scopeKind: r.scope_kind,
        address: r.address || null,
        region: r.region || null,
      })),
    };
  }

  // Suggestion index: distinct product names are tiny at archive scale (~9k
  // names, a few hundred KB) and only change when the projection DB is
  // rebuilt, so they are held in memory and invalidated with the same
  // dbSignature probe the deals cache uses. Suggestions fire per keystroke,
  // and the SQL path (full-table DISTINCT + ORDER BY scan) was the slowest
  // endpoint p50 and serialized badly under concurrent typing (bench:
  // ~1,280 rps at 8x concurrency); the in-memory pass removes that scan.
  const suggestionIndex = { sig: undefined, names: null, folded: null };

  function suggestionIndexFor() {
    const sig = typeof dbSignature === 'function' ? dbSignature() : null;
    if (suggestionIndex.names && suggestionIndex.sig === sig) return suggestionIndex;
    // ORDER BY name (BINARY collation, UTF-8 byte order) fixes the row order
    // coming out of SQLite, so the array is already suggestion-ordered and a
    // match scan can stop at LIMIT 10 without sorting.
    const rows = db().prepare('SELECT DISTINCT name FROM products ORDER BY name').all();
    suggestionIndex.names = rows.map(r => r.name).filter(n => typeof n === 'string');
    // Mirror LIKE ... COLLATE NOCASE, which case-folds ASCII A-Z only.
    suggestionIndex.folded = suggestionIndex.names.map(n => n.replace(/[A-Z]/g, c => c.toLowerCase()));
    suggestionIndex.sig = sig;
    return suggestionIndex;
  }

  async function searchSuggestions(ctx) {
    db();
    const q = (ctx.query.query || '').trim();
    if (q.length < 2) {
      throw new StatusError(400, 'QUERY_TOO_SHORT', 'Search query must be at least 2 characters');
    }
    if (q.length > 100) {
      throw new StatusError(400, 'QUERY_TOO_LONG', 'Search query must be 100 characters or fewer');
    }

    // Plain text — the overwhelming case for search-as-you-type — matches
    // against the in-memory index with the exact semantics of the SQL below:
    // `LIKE '%q%' COLLATE NOCASE` on a wildcard-free q is an ASCII-folded
    // substring test, and row order/limit carry over from the sorted index.
    // Queries containing LIKE wildcards (% _ \) keep the SQL path so their
    // wildcard semantics are preserved bit-for-bit.
    if (!/[%_\\]/.test(q)) {
      const idx = suggestionIndexFor();
      const needle = q.replace(/[A-Z]/g, c => c.toLowerCase());
      const out = [];
      for (let i = 0; i < idx.names.length; i++) {
        if (idx.folded[i].includes(needle)) {
          out.push(idx.names[i]);
          if (out.length === 10) break;
        }
      }
      return { suggestions: out };
    }

    const rows = db().prepare(`
      SELECT DISTINCT name FROM products
      WHERE name LIKE ? COLLATE NOCASE
      ORDER BY name
      LIMIT 10
    `).all(`%${q.replace(/[%_]/g, '\\$&')}%`);

    return { suggestions: rows.map(r => r.name) };
  }

  // Deal universe cache: /api/deals re-reads ~90 days of offer revisions and
  // runs two analytics passes per request (~100ms at current archive size).
  // Offer data only changes when the projection DB is rebuilt (nightly), so
  // the computation is memoized per retailer for dealsCacheTtlMs (0 disables)
  // and invalidated early when dbSignature (e.g. the DB file's mtime) changes.
  // Filter, limit, and tier ordering stay per-request; cached deal objects
  // are never mutated (the tier path copies before attaching .tier).
  // Concurrent cache misses are single-flighted: the first caller computes,
  // the rest await the same in-flight promise. The pending entry is removed
  // when the computation settles, so a failure is never sticky — the next
  // request recomputes. If dbSignature changes mid-flight, the stale
  // computation finishes unused and a fresh one starts.
  const dealsCache = new Map();
  const pendingDealsCompute = new Map();

  async function computeDealsUniverse(retailer, key, now, sig) {
    const rows = typeof queryDealSignals === 'function'
      ? await queryDealSignals(db(), retailer)
      : defaultQueryDealSignals(db(), retailer);

    const historyBacked = [];
    const advertised = [];

    for (const r of rows) {
      const dropPercent = r.drop_percent || 0;
      const deal = {
        product: {
          id: r.product_id,
          name: r.product_name || null,
          brand: r.product_brand || null,
          category: r.product_category || null,
          imageUrl: r.product_image || null,
        },
        priceContext: {
          retailerId: r.retailer_id,
          retailerName: retailerName(r.retailer_id),
          storeId: r.store_id,
          storeName: r.store_name,
        },
        signal: {
          kind: r.signal_kind,
          policy: r.price_policy || 'public',
          dropPercent,
          referenceCents: r.reference_cents,
          currentCents: r.current_cents,
          savingsText: dropPercent > 0 ? `${Math.round(dropPercent)}% off` : 'All-time low',
        },
        cents: { regular: r.reference_cents, current: r.current_cents },
        calculatedAt: r.calculated_at != null ? new Date(r.calculated_at).toISOString() : null,
      };
      if (r.signal_kind === 'advertised_only') advertised.push(deal);
      else historyBacked.push(deal);
    }

    // Deduplicate: if the same product+store offer appears in both, keep
    // history-backed (it has stronger evidence) and remove from advertised.
    if (historyBacked.length > 0 && advertised.length > 0) {
      const historyKey = new Set(
        historyBacked.map(d => `${d.product.id}\x00${d.priceContext.storeId}`)
      );
      for (let i = advertised.length - 1; i >= 0; i--) {
        const adKey = `${advertised[i].product.id}\x00${advertised[i].priceContext.storeId}`;
        if (historyKey.has(adKey)) {
          advertised.splice(i, 1);
        }
      }
    }

    // Ordering: history-backed (sorted by drop descending), then advertised.
    historyBacked.sort((a, b) => (b.signal.dropPercent || 0) - (a.signal.dropPercent || 0));
    advertised.sort((a, b) => (b.signal.dropPercent || 0) - (a.signal.dropPercent || 0));

    const storeCounts = db().prepare('SELECT COUNT(DISTINCT id) AS total FROM price_contexts').get();
    const storesWithOffers = db().prepare('SELECT COUNT(DISTINCT context_id) AS c FROM offer_revisions').get();

    const entry = {
      computedAt: now,
      sig,
      historyBacked, advertised,
      archiveFreshness: { totalStores: storeCounts?.total || 0, storesWithData: storesWithOffers?.c || 0 },
    };
    dealsCache.clear();
    dealsCache.set(key, entry);
    return entry;
  }

  // Returns a promise for the deal universe entry for `retailer`, serving a
  // fresh cache hit directly and otherwise joining (or starting) the
  // in-flight computation for that key.
  function dealUniverse(retailer, now) {
    const key = retailer || '*';
    const sig = typeof dbSignature === 'function' ? dbSignature() : undefined;
    const hit = dealsCache.get(key);
    if (hit && sig === hit.sig && now - hit.computedAt < dealsCacheTtlMs) return Promise.resolve(hit);

    const inflight = pendingDealsCompute.get(key);
    if (inflight && inflight.sig === sig) return inflight.promise;

    const pending = { sig, promise: null };
    pending.promise = computeDealsUniverse(retailer, key, now, sig).finally(() => {
      if (pendingDealsCompute.get(key) === pending) pendingDealsCompute.delete(key);
    });
    pendingDealsCompute.set(key, pending);
    return pending.promise;
  }

  async function listDeals(ctx) {
    db();
    const filter = ctx.query.filter || 'all';
    const limit = clamp(ctx.query.limit, 1, 200, 120);
    const retailer = (ctx.query.retailer || '').trim();

    if (!['history-backed', 'advertised', 'all'].includes(filter)) {
      throw new StatusError(400, 'INVALID_FILTER', 'Filter must be history-backed, advertised, or all');
    }

    const now = ctx.clock();
    const universe = await dealUniverse(retailer, now);
    let historyBacked = universe.historyBacked;
    let advertised = universe.advertised;

    if (filter === 'history-backed') {
      advertised = [];
    } else if (filter === 'advertised') {
      historyBacked = [];
    }

    const totalCount = historyBacked.length + advertised.length;
    const combined = [...historyBacked, ...advertised];

    // Feed prioritization: partition into tiers for authenticated users.
    // Tier 1: watch-list products at preferred stores (highest visibility)
    // Tier 2: watch-list products at other stores
    // Tier 3: all other deals
    // Each tier sorted by discount magnitude descending.
    const tiers = loadUserTiers(ctx);
    let ordered = combined;
    let tierSummary = null;
    if (tiers) {
      const bucket = {
        [TIER_WATCH_PREFERRED]: [],
        [TIER_WATCH_OTHER]: [],
        [TIER_ALL]: [],
      };
      for (const deal of combined) {
        const t = dealTier(deal, tiers);
        bucket[t].push({ ...deal, tier: t });
      }
      ordered = [...bucket[TIER_WATCH_PREFERRED], ...bucket[TIER_WATCH_OTHER], ...bucket[TIER_ALL]];
      tierSummary = {
        watchPreferred: bucket[TIER_WATCH_PREFERRED].length,
        watchOther: bucket[TIER_WATCH_OTHER].length,
        all: bucket[TIER_ALL].length,
      };
    }

    const capped = ordered.slice(0, limit);
    const resultHistory = capped.filter(d => d.signal.kind !== 'advertised_only');
    const resultAdvertised = capped.filter(d => d.signal.kind === 'advertised_only');

    const body = {
      historyBacked: resultHistory, advertised: resultAdvertised, stale: false,
      archiveFreshness: universe.archiveFreshness,
      total: totalCount, limit,
    };
    if (tierSummary) body.tiers = tierSummary;
    // Anonymous responses are byte-stable for the TTL window, so the Server
    // can reuse serialized+compressed bytes (CachedResponse). Tiered
    // responses are user-specific and stay plain. The token rotates exactly
    // when the payload does: retailer, projection signature, and compute
    // generation are all part of it.
    if (!tiers) {
      return new CachedResponse({
        token: `${retailer || '*'}|${universe.sig}|${universe.computedAt}|${filter}|${limit}`,
        body,
        maxAgeMs: dealsCacheTtlMs,
      });
    }
    return body;
  }

  return { health, listProducts, getProduct, getProductHistory, listStores, searchSuggestions, listDeals };
}

