import { calculateSales, calculateOngoingSales } from '../analytics.js';

// Pre-materialization of deal signals (DECISIONLOG 2026-09-06, owner-approved):
// the rebuild runs the SAME analytics the runtime /api/deals path used, with
// the SAME parameter set, and stores one row per surviving offer signal.
// Row semantics: calculated_at is the CURRENT OBSERVATION's epoch (exposed as
// calculatedAt by the response), reference/current/drop mirror the signal
// fields the response derives. Keep DEAL_SIGNAL_PARAMS in sync with
// src/server/handlers/public.js until the handler switch lands.
export const DEAL_SIGNALS_CALC_VERSION = '1';

const DAY_MS = 24 * 60 * 60 * 1000;

export const DEAL_SIGNAL_PARAMS = {
  windowDays: 90,
  freshWithinDays: 7,
  baselineDays: 90,
  minSamples: 3,
  minDropPercent: 0,
  pricePolicy: 'public',
};

export function materializeDealSignals(db, { now }) {
  const fromMs = now - DEAL_SIGNAL_PARAMS.windowDays * DAY_MS;
  const rows = db.prepare(`
    SELECT or2.product_id, or2.price_regular_cents, or2.price_promo_cents,
           or2.price_member_cents, or2.comparative, or2.promotion_data, or2.observed_at,
           p.name AS product_name, p.brand AS product_brand,
           p.category AS product_category, p.image_url AS product_image,
           pc.id AS context_id, pc.retailer_id, pc.store_id, pc.store_name
    FROM offer_revisions or2
    JOIN products p ON p.id = or2.product_id
    JOIN price_contexts pc ON pc.id = or2.context_id
    WHERE or2.observed_at >= ? AND or2.observed_at <= ?
    ORDER BY or2.observed_at
  `).all(fromMs, now);

  // deal groups key on productId + storeId; keep the numeric context id
  // alongside so signal rows can reference price_contexts.
  const contextByKey = new Map();
  const observations = rows.map(r => {
    contextByKey.set(`${r.product_id}\u0000${r.store_id}`, r.context_id);
    const isAdvertisedDeal = r.price_promo_cents != null && r.price_promo_cents < r.price_regular_cents;
    const isMemberDeal = r.price_member_cents != null && r.price_member_cents < r.price_regular_cents;
    const hasReduction = isAdvertisedDeal || isMemberDeal;
    const observedAtIso = new Date(r.observed_at).toISOString();
    const observation = {
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
      observedAt: observedAtIso,
      lastSeenAt: observedAtIso,
      isOnSpecial: hasReduction,
    };
    if (hasReduction && r.promotion_data) observation.promotion = JSON.parse(r.promotion_data);
    return observation;
  });

  const at = new Date(now).toISOString();
  const base = {
    calc_version: DEAL_SIGNALS_CALC_VERSION,
    baseline_window_days: DEAL_SIGNAL_PARAMS.baselineDays,
    min_samples: DEAL_SIGNAL_PARAMS.minSamples,
    price_policy: DEAL_SIGNAL_PARAMS.pricePolicy,
  };
  const signals = [];

  for (const sale of calculateSales(observations, {
    at,
    freshWithinDays: DEAL_SIGNAL_PARAMS.freshWithinDays,
    baselineDays: DEAL_SIGNAL_PARAMS.baselineDays,
    minSamples: DEAL_SIGNAL_PARAMS.minSamples,
    minDropPercent: DEAL_SIGNAL_PARAMS.minDropPercent,
    includeAllTimeLows: true,
    pricePolicy: DEAL_SIGNAL_PARAMS.pricePolicy,
  })) {
    const dropPercent = sale.dropPercent || 0;
    if (dropPercent <= 0 && !sale.isAllTimeLow) continue;
    signals.push({
      ...base,
      product_id: sale.product.id,
      context_id: contextByKey.get(`${sale.product.id}\u0000${sale.store.id}`),
      signal_kind: sale.isAllTimeLow ? 'all_time_low' : 'history_drop',
      reference_cents: sale.baseline?.averageCents || sale.current?.cents || 0,
      current_cents: sale.current?.cents || 0,
      drop_percent: dropPercent,
      calculated_at: Date.parse(sale.current?.observedAt || at),
    });
  }

  for (const sale of calculateOngoingSales(observations, {
    at,
    freshWithinDays: DEAL_SIGNAL_PARAMS.freshWithinDays,
    pricePolicy: DEAL_SIGNAL_PARAMS.pricePolicy,
  })) {
    const savePercent = sale.savePercent || 0;
    if (savePercent <= 0) continue;
    signals.push({
      ...base,
      product_id: sale.product.id,
      context_id: contextByKey.get(`${sale.product.id}\u0000${sale.store.id}`),
      signal_kind: 'advertised_only',
      reference_cents: sale.regularCents || 0,
      current_cents: sale.current?.cents || 0,
      drop_percent: savePercent,
      calculated_at: Date.parse(sale.current?.observedAt || at),
    });
  }

  return signals;
}
