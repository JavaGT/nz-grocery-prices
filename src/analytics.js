const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Single source of truth for effective-price semantics (module-private; see
 * buildPriceSeries for the exported surface built on top of it).
 *
 * Candidates: regular always; promo when defined; member when
 * pricePolicy === "member" and defined. Lowest cents wins; ties resolve in
 * regular > promo > member priority order (reduce only replaces on a
 * strictly lower price, so earlier candidates win ties).
 *
 * Promotion windows: when the observation carries a promotion object with
 * startsAt/endsAt, promo cents only count as active if the window includes
 * `at` (boundaries inclusive on both ends). Without a promotion object — or
 * without window fields — promo cents are treated as always active, which
 * preserves legacy behavior for data collected before windows existed.
 *
 * Callers anchor evaluation deliberately: baseline/history points evaluate
 * at their own observedAt, ongoing sales at query.at. When `at` is omitted
 * windows cannot exclude anything (legacy fallback).
 */
function selectEffectivePrice(observation, { pricePolicy = "public", at } = {}) {
  const atMs = at === undefined ? undefined : Date.parse(at);
  const promoAllowed =
    atMs === undefined ||
    !observation.promotion ||
    promotionIsActive(observation.promotion, atMs);

  const candidates = [
    { cents: observation.price.regularCents, kind: "regular" },
    ...(observation.price.promoCents === undefined || !promoAllowed
      ? []
      : [{ cents: observation.price.promoCents, kind: "promo" }]),
    ...(pricePolicy !== "member" || observation.price.memberCents === undefined
      ? []
      : [{ cents: observation.price.memberCents, kind: "member" }])
  ];

  return candidates.reduce((lowest, candidate) =>
    candidate.cents < lowest.cents ? candidate : lowest
  );
}

/** Groups observations by offer (productId + storeId), preserving keys. */
function groupObservations(observations) {
  const groups = new Map();

  for (const observation of observations) {
    const key = `${observation.product.id}\u0000${observation.store.id}`;
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }

  return groups;
}

/**
 * Ascending observedAt sort applied inside analytics: input order is never
 * trusted. Array.prototype.sort is stable, so observations sharing a
 * timestamp keep their input order as the tie-break.
 */
function byObservedAt(left, right) {
  return Date.parse(left.observedAt) - Date.parse(right.observedAt);
}

function roundPercent(value) {
  return Math.round(value * 100) / 100;
}

function promotionIsActive(promotion, atMs) {
  const startsAt = promotion?.startsAt ? Date.parse(promotion.startsAt) : undefined;
  const endsAt = promotion?.endsAt ? Date.parse(promotion.endsAt) : undefined;
  return (
    (!Number.isFinite(startsAt) || startsAt <= atMs) &&
    (!Number.isFinite(endsAt) || endsAt >= atMs)
  );
}

export function calculateSales(observations, query = {}) {
  const at = query.at ?? new Date().toISOString();
  const atMs = Date.parse(at);
  const freshWithinDays = query.freshWithinDays ?? 7;
  const baselineDays = query.baselineDays ?? 90;
  const minSamples = query.minSamples ?? 2;
  const minDropPercent = query.minDropPercent ?? 0;
  const includeAllTimeLows = query.includeAllTimeLows ?? true;
  const pricePolicy = query.pricePolicy ?? "public";
  const productIds = query.productIds ? new Set(query.productIds) : undefined;
  const sales = [];

  for (const group of groupObservations(observations).values()) {
    const relevant = group.filter((observation) =>
      !productIds || productIds.has(observation.product.id)
    );
    if (relevant.length < 2) continue;
    relevant.sort(byObservedAt);

    const currentObservation = relevant.at(-1);
    const currentAtMs = Date.parse(currentObservation.observedAt);
    if (currentAtMs < atMs - freshWithinDays * DAY_MS) continue;

    const previous = relevant.slice(0, -1);
    const baselineStart = currentAtMs - baselineDays * DAY_MS;
    const baseline = previous.filter(
      (observation) => Date.parse(observation.observedAt) >= baselineStart
    );
    if (baseline.length < minSamples) continue;

    // Every observation — current and historical — evaluates promotion
    // activity at its own observedAt, so stale promotional cents never
    // pollute baselines (see test fixture: GROK-8 behavior fix).
    const current = selectEffectivePrice(currentObservation, {
      pricePolicy,
      at: currentObservation.observedAt
    });
    const baselinePrices = baseline.map(
      (observation) =>
        selectEffectivePrice(observation, { pricePolicy, at: observation.observedAt }).cents
    );
    const allPreviousPrices = previous.map(
      (observation) =>
        selectEffectivePrice(observation, { pricePolicy, at: observation.observedAt }).cents
    );
    const average = baselinePrices.reduce((sum, price) => sum + price, 0) / baselinePrices.length;
    const dropPercent = ((average - current.cents) / average) * 100;
    const previousLowCents = Math.min(...allPreviousPrices);
    const isAllTimeLow = current.cents < previousLowCents;

    if (dropPercent < minDropPercent && !(includeAllTimeLows && isAllTimeLow)) continue;

    sales.push({
      product: structuredClone(currentObservation.product),
      store: structuredClone(currentObservation.store),
      current: {
        ...current,
        observedAt: currentObservation.observedAt
      },
      baseline: {
        averageCents: Math.round(average),
        sampleCount: baseline.length,
        days: baselineDays
      },
      dropPercent: roundPercent(dropPercent),
      previousLowCents,
      isAllTimeLow,
      promotion: currentObservation.promotion
        ? structuredClone(currentObservation.promotion)
        : undefined
    });
  }

  return sales.sort((left, right) => right.dropPercent - left.dropPercent);
}

export function calculateOngoingSales(observations, query = {}) {
  const at = query.at ?? new Date().toISOString();
  const atMs = Date.parse(at);
  const freshWithinDays = query.freshWithinDays ?? 7;
  const pricePolicy = query.pricePolicy ?? "public";
  const productIds = query.productIds ? new Set(query.productIds) : undefined;

  const candidates = [];
  for (const observation of observations) {
    if (Date.parse(observation.observedAt) > atMs) continue;
    if (query.retailer && observation.store.retailer !== query.retailer) continue;
    if (query.storeId && observation.store.id !== query.storeId) continue;
    if (productIds && !productIds.has(observation.product.id)) continue;
    candidates.push(observation);
  }

  // Latest observation per offer wins regardless of input order; the stable
  // sort keeps input order among equal timestamps, preserving the previous
  // last-write-wins outcome for pre-sorted input.
  const latest = new Map();
  for (const observation of [...candidates].sort(byObservedAt)) {
    latest.set(`${observation.product.id}\u0000${observation.store.id}`, observation);
  }

  return [...latest.values()]
    .filter((observation) =>
      Date.parse(observation.lastSeenAt ?? observation.observedAt) >= atMs - freshWithinDays * DAY_MS
    )
    .filter((observation) =>
      observation.isOnSpecial !== false &&
      observation.promotion &&
      promotionIsActive(observation.promotion, atMs) &&
      (observation.price.promoCents !== undefined ||
        (pricePolicy === "member" && observation.price.memberCents !== undefined))
    )
    .map((observation) => {
      // Ongoing sales evaluate promotion activity at query.at, not at the
      // observation time: a promo live "now" is sellable now.
      const current = selectEffectivePrice(observation, { pricePolicy, at });
      const regularCents = observation.price.regularCents;
      const savePercent = regularCents > current.cents
        ? roundPercent(((regularCents - current.cents) / regularCents) * 100)
        : observation.promotion?.savePercent;
      return {
        product: structuredClone(observation.product),
        store: structuredClone(observation.store),
        current: { ...current, observedAt: observation.lastSeenAt ?? observation.observedAt },
        regularCents,
        savePercent,
        promotion: structuredClone(observation.promotion),
      };
    })
    .sort((left, right) => (right.savePercent ?? 0) - (left.savePercent ?? 0));
}

/**
 * Builds per-offer price histories: one series per productId+storeId pair,
 * points sorted ascending by observedAt, each priced by evaluating promotion
 * activity at that point's own observedAt. Series are sorted by productId
 * then storeId; empty input yields [].
 */
export function buildPriceSeries(observations, { pricePolicy = "public" } = {}) {
  const series = [...groupObservations(observations).entries()]
    .map(([key, group]) => {
      const [productId, storeId] = key.split("\u0000");
      const points = [...group].sort(byObservedAt).map((observation) => {
        const price = selectEffectivePrice(observation, {
          pricePolicy,
          at: observation.observedAt
        });
        return { observedAt: observation.observedAt, cents: price.cents, kind: price.kind };
      });
      return { productId, storeId, points };
    });

  return series.sort((left, right) => {
    if (left.productId !== right.productId) {
      return left.productId < right.productId ? -1 : 1;
    }
    if (left.storeId !== right.storeId) {
      return left.storeId < right.storeId ? -1 : 1;
    }
    return 0;
  });
}

export function toAgentFeed(sales, generatedAt, ongoingSales = []) {
  return {
    generatedAt,
    currency: "NZD",
    ongoingSales: ongoingSales.map((sale) => ({
      productId: sale.product.id,
      productName: sale.product.name,
      brand: sale.product.brand,
      gtin: sale.product.gtin,
      storeId: sale.store.id,
      storeName: sale.store.name,
      retailer: sale.store.retailer,
      currentCents: sale.current.cents,
      regularCents: sale.regularCents,
      priceKind: sale.current.kind,
      savePercent: sale.savePercent,
      observedAt: sale.current.observedAt,
      promotion: sale.promotion,
    })),
    sales: sales.map((sale) => ({
      productId: sale.product.id,
      productName: sale.product.name,
      brand: sale.product.brand,
      storeId: sale.store.id,
      storeName: sale.store.name,
      retailer: sale.store.retailer,
      currentCents: sale.current.cents,
      priceKind: sale.current.kind,
      baselineAverageCents: sale.baseline.averageCents,
      baselineSampleCount: sale.baseline.sampleCount,
      dropPercent: sale.dropPercent,
      isAllTimeLow: sale.isAllTimeLow,
      observedAt: sale.current.observedAt,
      promotion: sale.promotion
    }))
  };
}
