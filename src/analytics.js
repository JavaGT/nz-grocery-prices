const DAY_MS = 24 * 60 * 60 * 1000;

function effectivePrice(observation, policy) {
  const candidates = [
    { cents: observation.price.regularCents, kind: "regular" },
    ...(observation.price.promoCents === undefined
      ? []
      : [{ cents: observation.price.promoCents, kind: "promo" }]),
    ...(policy !== "member" || observation.price.memberCents === undefined
      ? []
      : [{ cents: observation.price.memberCents, kind: "member" }])
  ];

  return candidates.reduce((lowest, candidate) =>
    candidate.cents < lowest.cents ? candidate : lowest
  );
}

function groupObservations(observations) {
  const groups = new Map();

  for (const observation of observations) {
    const key = `${observation.product.id}\u0000${observation.store.id}`;
    const group = groups.get(key) ?? [];
    group.push(observation);
    groups.set(key, group);
  }

  return groups.values();
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

  for (const group of groupObservations(observations)) {
    const relevant = group.filter((observation) =>
      !productIds || productIds.has(observation.product.id)
    );
    if (relevant.length < 2) continue;

    const currentObservation = relevant.at(-1);
    const currentAtMs = Date.parse(currentObservation.observedAt);
    if (currentAtMs < atMs - freshWithinDays * DAY_MS) continue;

    const previous = relevant.slice(0, -1);
    const baselineStart = currentAtMs - baselineDays * DAY_MS;
    const baseline = previous.filter(
      (observation) => Date.parse(observation.observedAt) >= baselineStart
    );
    if (baseline.length < minSamples) continue;

    const current = effectivePrice(currentObservation, pricePolicy);
    const baselinePrices = baseline.map(
      (observation) => effectivePrice(observation, pricePolicy).cents
    );
    const allPreviousPrices = previous.map(
      (observation) => effectivePrice(observation, pricePolicy).cents
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
  const latest = new Map();

  for (const observation of observations) {
    if (Date.parse(observation.observedAt) > atMs) continue;
    if (query.retailer && observation.store.retailer !== query.retailer) continue;
    if (query.storeId && observation.store.id !== query.storeId) continue;
    if (productIds && !productIds.has(observation.product.id)) continue;
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
      const current = effectivePrice(observation, pricePolicy);
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
