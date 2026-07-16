import { StatusError } from '../server.js';
import { calculateSales, calculateOngoingSales } from '../../analytics.js';

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

export function createPublicHandlers({ getDb, appDb, auth, clock, startedAt, queryDbObservations }) {
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
    let meta;
    try {
      const d = getDb ? getDb() : null;
      if (d) {
        const rows = d.prepare('SELECT key, value FROM _meta').all();
        const m = Object.fromEntries(rows.map(r => [r.key, r.value]));
        meta = {
          exists: true,
          fingerprint: m.jsonl_fingerprint || null,
          builtAt: m.built_at || null,
          recordsImported: Number(m.records_imported) || 0,
        };
      } else {
        meta = { exists: false, fingerprint: null, builtAt: null, recordsImported: 0 };
      }
    } catch {
      meta = { exists: false, fingerprint: null, builtAt: null, recordsImported: 0 };
    }

    return {
      status: meta.exists ? 'ok' : 'degraded',
      startedAt: new Date(startedAt).toISOString(),
      uptime: ctx.clock() - startedAt,
      projection: meta,
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

    const countRow = db().prepare(`SELECT COUNT(*) AS c FROM products ${whereClause}`).get(...params);
    const total = countRow ? countRow.c : 0;

    const orderParams = q ? [q, `%${q}%`] : [];
    const rows = db().prepare(`SELECT * FROM products ${whereClause} ${orderClause} LIMIT ? OFFSET ?`).all(
      ...params, ...orderParams, limit, offset
    );

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

    const offers = db().prepare(`
      SELECT or2.offer_key, or2.context_id, or2.price_regular_cents, or2.price_promo_cents,
             or2.price_member_cents, or2.comparative, or2.promotion_data, or2.source_data,
             or2.observed_at,
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

    const rows = db().prepare(`
      SELECT offer_key, context_id, product_id, price_regular_cents, price_promo_cents,
             price_member_cents, comparative, promotion_data, source_data, observed_at
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

  async function searchSuggestions(ctx) {
    db();
    const q = (ctx.query.query || '').trim();
    if (q.length < 2) {
      throw new StatusError(400, 'QUERY_TOO_SHORT', 'Search query must be at least 2 characters');
    }
    if (q.length > 100) {
      throw new StatusError(400, 'QUERY_TOO_LONG', 'Search query must be 100 characters or fewer');
    }

    const rows = db().prepare(`
      SELECT DISTINCT name FROM products
      WHERE name LIKE ? COLLATE NOCASE
      ORDER BY name
      LIMIT 10
    `).all(`%${q.replace(/[%_]/g, '\\$&')}%`);

    return { suggestions: rows.map(r => r.name) };
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
    const baselineMs = 90 * 24 * 60 * 60 * 1000;
    const fromMs = now - baselineMs;

    let observations = [];
    if (typeof queryDbObservations === 'function') {
      observations = queryDbObservations(db(), fromMs, now);
    } else {
      observations = defaultQueryDbObservations(db(), fromMs, now);
    }

    if (retailer) {
      observations = observations.filter(o => o.store && o.store.retailer === retailer);
    }

    const fromDate = new Date(fromMs).toISOString();
    const atDate = new Date(now).toISOString();

    const salesResult = calculateSales(observations, {
      at: atDate,
      freshWithinDays: 7,
      baselineDays: 90,
      minSamples: 3,
      minDropPercent: 0,
      includeAllTimeLows: true,
      pricePolicy: 'public',
    });

    const ongoingResult = calculateOngoingSales(observations, {
      at: atDate,
      freshWithinDays: 7,
      retailer: retailer || undefined,
      pricePolicy: 'public',
    });

    const historyBacked = [];
    const advertised = [];

    for (const sale of salesResult) {
      const pid = sale.product?.id || 'unknown';
      const storeRetailer = sale.store?.retailer || 'unknown';
      const dropPct = sale.dropPercent || 0;
      if (dropPct <= 0 && !sale.isAllTimeLow) continue;
      const savingsText = dropPct > 0 ? `${Math.round(dropPct)}% off` : 'All-time low';
      historyBacked.push({
        product: {
          id: pid,
          name: sale.product?.name || null,
          brand: sale.product?.brand || null,
          category: (sale.product?.categories || [])[0] || null,
          imageUrl: ((sale.product?.images || [])[0]) || null,
        },
        priceContext: {
          retailerId: storeRetailer,
          retailerName: retailerName(storeRetailer),
          storeId: sale.store?.id || null,
          storeName: sale.store?.name || null,
        },
        signal: {
          kind: sale.isAllTimeLow ? 'all_time_low' : 'history_drop',
          policy: 'public',
          dropPercent: sale.dropPercent,
          referenceCents: sale.baseline?.averageCents || sale.current?.cents || 0,
          currentCents: sale.current?.cents || 0,
          savingsText,
        },
        cents: { regular: sale.baseline?.averageCents || sale.current?.cents || 0, current: sale.current?.cents || 0 },
        calculatedAt: sale.current?.observedAt || atDate,
      });
    }

    for (const sale of ongoingResult) {
      const pid = sale.product?.id || 'unknown';
      const storeRetailer = sale.store?.retailer || 'unknown';
      const regCents = sale.regularCents || 0;
      const curCents = sale.current?.cents || 0;
      const savePct = sale.savePercent || 0;
      if (savePct <= 0) continue;
      advertised.push({
        product: {
          id: pid,
          name: sale.product?.name || null,
          brand: sale.product?.brand || null,
          category: (sale.product?.categories || [])[0] || null,
          imageUrl: ((sale.product?.images || [])[0]) || null,
        },
        priceContext: {
          retailerId: storeRetailer,
          retailerName: retailerName(storeRetailer),
          storeId: sale.store?.id || null,
          storeName: sale.store?.name || null,
        },
        signal: {
          kind: 'advertised_only',
          policy: 'public',
          dropPercent: sale.savePercent || 0,
          referenceCents: regCents,
          currentCents: curCents,
          savingsText: sale.savePercent != null ? `${Math.round(sale.savePercent)}% off` : 'On special',
        },
        cents: { regular: regCents, current: curCents },
        calculatedAt: sale.current?.observedAt || atDate,
      });
    }

    if (filter === 'history-backed') {
      advertised.length = 0;
    } else if (filter === 'advertised') {
      historyBacked.length = 0;
    }

    const totalCount = historyBacked.length + advertised.length;

    // Deduplicate: if the same product+store offer appears in both, keep
    // history-backed (it has stronger evidence) and remove from advertised.
    if (historyBacked.length > 0 && advertised.length > 0) {
      const historyKey = new Set(
        historyBacked.map(d => `${d.product.id}\x00${d.priceContext.storeId}`)
      );
      for (let i = advertised.length - 1; i >= 0; i--) {
        const key = `${advertised[i].product.id}\x00${advertised[i].priceContext.storeId}`;
        if (historyKey.has(key)) {
          advertised.splice(i, 1);
        }
      }
    }

    // Ordering: history-backed (sorted by drop descending), then advertised.
    // Cap combined total to limit.
    historyBacked.sort((a, b) => (b.signal.dropPercent || 0) - (a.signal.dropPercent || 0));
    advertised.sort((a, b) => (b.signal.dropPercent || 0) - (a.signal.dropPercent || 0));
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
        deal.tier = t;
        bucket[t].push(deal);
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

    const storeCounts = db().prepare('SELECT COUNT(DISTINCT id) AS total FROM price_contexts').get();
    const storesWithOffers = db().prepare('SELECT COUNT(DISTINCT context_id) AS c FROM offer_revisions').get();

    return {
      historyBacked: resultHistory, advertised: resultAdvertised, stale: false,
      archiveFreshness: { totalStores: storeCounts?.total || 0, storesWithData: storesWithOffers?.c || 0 },
      total: totalCount, limit,
      ...(tierSummary ? { tiers: tierSummary } : {}),
    };
  }

  return { health, listProducts, getProduct, getProductHistory, listStores, searchSuggestions, listDeals };
}

export function defaultQueryDbObservations(db, fromMs, toMs) {
  const rows = db.prepare(`
    SELECT or2.offer_key, or2.product_id, or2.context_id, or2.rev_hash,
           or2.price_regular_cents, or2.price_promo_cents, or2.price_member_cents,
           or2.comparative, or2.promotion_data, or2.observed_at,
           p.name AS product_name, p.brand AS product_brand,
           p.category AS product_category, p.image_url AS product_image,
           pc.retailer_id, pc.store_id, pc.store_name,
           r.name AS retailer_name
    FROM offer_revisions or2
    JOIN products p ON p.id = or2.product_id
    JOIN price_contexts pc ON pc.id = or2.context_id
    JOIN retailers r ON r.id = pc.retailer_id
    WHERE or2.observed_at >= ? AND or2.observed_at <= ?
    ORDER BY or2.observed_at
  `).all(fromMs, toMs);

  return rows.map(r => {
    const isAdvertisedDeal = r.price_promo_cents != null && r.price_promo_cents < r.price_regular_cents;
    const isMemberDeal = r.price_member_cents != null && r.price_member_cents < r.price_regular_cents;
    const hasReduction = isAdvertisedDeal || isMemberDeal;
    const rawPromotion = r.promotion_data ? JSON.parse(r.promotion_data) : undefined;
    return {
      product: {
        id: r.product_id,
        name: r.product_name,
        brand: r.product_brand,
        categories: r.product_category ? [r.product_category] : [],
        images: r.product_image ? [r.product_image] : [],
      },
      store: {
        id: r.store_id,
        name: r.store_name,
        retailer: r.retailer_id,
      },
      price: {
        regularCents: r.price_regular_cents,
        promoCents: r.price_promo_cents ?? undefined,
        memberCents: r.price_member_cents ?? undefined,
        comparative: r.comparative ? JSON.parse(r.comparative) : undefined,
      },
      observedAt: new Date(r.observed_at).toISOString(),
      lastSeenAt: new Date(r.observed_at).toISOString(),
      isOnSpecial: hasReduction,
      ...(hasReduction && rawPromotion ? { promotion: rawPromotion } : {}),
    };
  });
}
