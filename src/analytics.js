import { cloneJson } from "./archive-records.js";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Single source of truth for effective-price semantics (module-private; see
 * buildPriceSeries for the exported surface built on top of it).
 *
 * Candidates: regular always; promo when defined; member when
 * pricePolicy === "member" and defined. Lowest cents wins; ties resolve in
 * regular > promo > member priority order (each step replaces only on a
 * strictly lower price, so earlier candidates win ties).
 *
 * Promotion windows: when the observation carries a promotion object with
 * startsAt/endsAt, promo cents only count as active if the window includes
 * `atMs` (boundaries inclusive on both ends). Without a promotion object — or
 * without window fields — promo cents are treated as always active, which
 * preserves legacy behavior for data collected before windows existed.
 *
 * Callers anchor evaluation deliberately: baseline/history points evaluate
 * at their own observedAt epoch, ongoing sales at query.at. When `atMs` is
 * omitted windows cannot exclude anything (legacy fallback). Taking the
 * epoch (not an ISO string) lets series/sales callers reuse the timestamp
 * they already parsed for sorting instead of re-parsing per observation.
 */
function selectEffectivePrice(observation, { pricePolicy = "public", atMs } = {}) {
  const promoAllowed =
    atMs === undefined ||
    !observation.promotion ||
    promotionIsActive(observation.promotion, atMs);

  const price = observation.price;
  let lowest = { cents: price.regularCents, kind: "regular" };
  if (
    promoAllowed &&
    price.promoCents !== undefined &&
    price.promoCents < lowest.cents
  ) {
    lowest = { cents: price.promoCents, kind: "promo" };
  }
  if (
    pricePolicy === "member" &&
    price.memberCents !== undefined &&
    price.memberCents < lowest.cents
  ) {
    lowest = { cents: price.memberCents, kind: "member" };
  }
  return lowest;
}

/**
 * Cents-only variant of selectEffectivePrice for callers that do not need
 * the kind (the calculateSales baseline window). Same candidate rules and
 * tie order — keep the two in sync. Exists because the baseline loop runs
 * once per historical observation and the kind wrapper was measurable
 * allocation pressure at archive scale.
 */
function effectiveCents(observation, pricePolicy, atMs) {
  const promoAllowed =
    atMs === undefined ||
    !observation.promotion ||
    promotionIsActive(observation.promotion, atMs);

  const price = observation.price;
  let lowest = price.regularCents;
  if (promoAllowed && price.promoCents !== undefined && price.promoCents < lowest) {
    lowest = price.promoCents;
  }
  if (
    pricePolicy === "member" &&
    price.memberCents !== undefined &&
    price.memberCents < lowest
  ) {
    lowest = price.memberCents;
  }
  return lowest;
}

/** Groups observations by offer (productId + storeId), preserving keys. */
function groupObservations(observations) {
  const groups = new Map();

  for (const observation of observations) {
    const key = `${observation.product.id}\u0000${observation.store.id}`;
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, [observation]);
    } else {
      group.push(observation);
    }
  }

  return groups;
}

/**
 * Comparator for observations decorated as [observedMs, observation]. All
 * analytics sorts run on pre-parsed epochs: sorting by repeated
 * `Date.parse` inside a comparator was the single hottest self-time item in
 * the 2026-09-09 analytics profile. Array.prototype.sort is stable, so
 * entries sharing a timestamp keep their input order as the tie-break.
 */
function byEpoch(left, right) {
  return left[0] - right[0];
}

/**
 * Parses a required ISO instant, rejecting garbage up front. Without this,
 * an invalid `at` becomes NaN and silently disables every time filter.
 */
function parseRequiredAt(functionName, at) {
  if (typeof at !== "string" || Number.isNaN(Date.parse(at))) {
    throw new TypeError(`${functionName} requires an explicit at (ISO string), got ${JSON.stringify(at) ?? "undefined"}`);
  }
  return Date.parse(at);
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
  // Deterministic contract: `at` is required. Wall-clock lives only in
  // PriceArchive's injected clock.
  const atMs = parseRequiredAt("calculateSales", query.at);
  const freshWithinDays = query.freshWithinDays ?? 7;
  const baselineDays = query.baselineDays ?? 90;
  const minSamples = query.minSamples ?? 2;
  const minDropPercent = query.minDropPercent ?? 0;
  const includeAllTimeLows = query.includeAllTimeLows ?? true;
  const pricePolicy = query.pricePolicy ?? "public";
  const productIds = query.productIds ? new Set(query.productIds) : undefined;
  const sales = [];

  for (const group of groupObservations(observations).values()) {
    // One pass per group: parse each observedAt exactly once, drop
    // unparseable timestamps (payload validation deliberately does not run
    // at load [GROK-4], so garbage can reach analytics) and non-selected
    // products. Entries stay decorated with their epoch so the sort below
    // and the baseline window check never re-parse.
    const timed = [];
    for (const observation of group) {
      if (productIds && !productIds.has(observation.product.id)) continue;
      const observedMs = Date.parse(observation.observedAt);
      if (Number.isNaN(observedMs)) continue;
      timed.push([observedMs, observation]);
    }
    if (timed.length < 2) continue;
    timed.sort(byEpoch);

    const currentEntry = timed[timed.length - 1];
    const currentAtMs = currentEntry[0];
    if (currentAtMs < atMs - freshWithinDays * DAY_MS) continue;

    // Single pass over previous observations: each observation's effective
    // price is evaluated at its own observedAt (GROK-8), the baseline window
    // sum accumulates in ascending observedAt order — the same summation
    // order as the previous baseline.map(...).reduce, so `average` is
    // bit-identical — and the running min over ALL previous observations
    // equals Math.min over allPreviousPrices.
    const baselineStart = currentAtMs - baselineDays * DAY_MS;
    let baselineSum = 0;
    let baselineCount = 0;
    let previousLowCents = Infinity;
    for (let index = 0; index < timed.length - 1; index += 1) {
      const [observedMs, observation] = timed[index];
      const cents = effectiveCents(observation, pricePolicy, observedMs);
      if (observedMs >= baselineStart) {
        baselineSum += cents;
        baselineCount += 1;
      }
      if (cents < previousLowCents) {
        previousLowCents = cents;
      }
    }
    if (baselineCount < minSamples) continue;
    const average = baselineSum / baselineCount;
    const current = selectEffectivePrice(currentEntry[1], {
      pricePolicy,
      atMs: currentAtMs
    });
    const dropPercent = ((average - current.cents) / average) * 100;
    const isAllTimeLow = current.cents < previousLowCents;

    if (dropPercent < minDropPercent && !(includeAllTimeLows && isAllTimeLow)) continue;

    sales.push({
      product: cloneJson(currentEntry[1].product),
      store: cloneJson(currentEntry[1].store),
      current: {
        ...current,
        observedAt: currentEntry[1].observedAt
      },
      baseline: {
        averageCents: Math.round(average),
        sampleCount: baselineCount,
        days: baselineDays
      },
      dropPercent: roundPercent(dropPercent),
      previousLowCents,
      isAllTimeLow,
      promotion: currentEntry[1].promotion
        ? cloneJson(currentEntry[1].promotion)
        : undefined
    });
  }

  return sales.sort((left, right) => right.dropPercent - left.dropPercent);
}

export function calculateOngoingSales(observations, query = {}) {
  // Deterministic contract: `at` is required. Wall-clock lives only in
  // PriceArchive's injected clock.
  const atMs = parseRequiredAt("calculateOngoingSales", query.at);
  const freshWithinDays = query.freshWithinDays ?? 7;
  const pricePolicy = query.pricePolicy ?? "public";
  const productIds = query.productIds ? new Set(query.productIds) : undefined;

  // One filter pass: the original parseable→fresh→retailer→store→product
  // chain was pure predicates, so folding them together (in any order)
  // preserves the candidate set and its input order. Candidates stay
  // decorated with their epoch for the stable latest-wins sort.
  const timed = [];
  for (const observation of observations) {
    if (query.retailer && observation.store.retailer !== query.retailer) continue;
    if (query.storeId && observation.store.id !== query.storeId) continue;
    if (productIds && !productIds.has(observation.product.id)) continue;
    const observedMs = Date.parse(observation.observedAt);
    if (Number.isNaN(observedMs) || observedMs > atMs) continue;
    timed.push([observedMs, observation]);
  }

  // Latest observation per offer wins regardless of input order; the stable
  // sort keeps input order among equal timestamps, preserving the previous
  // last-write-wins outcome for pre-sorted input.
  timed.sort(byEpoch);
  const latest = new Map();
  for (let index = 0; index < timed.length; index += 1) {
    const observation = timed[index][1];
    latest.set(`${observation.product.id}\u0000${observation.store.id}`, observation);
  }

  const freshFloorMs = atMs - freshWithinDays * DAY_MS;
  const ongoing = [];
  for (const observation of latest.values()) {
    if (
      Date.parse(observation.lastSeenAt ?? observation.observedAt) < freshFloorMs
    ) continue;
    if (
      observation.isOnSpecial === false ||
      !observation.promotion ||
      !promotionIsActive(observation.promotion, atMs) ||
      !(observation.price.promoCents !== undefined ||
        (pricePolicy === "member" && observation.price.memberCents !== undefined))
    ) continue;
    // Ongoing sales evaluate promotion activity at query.at, not at the
    // observation time: a promo live "now" is sellable now.
    const current = selectEffectivePrice(observation, { pricePolicy, atMs });
    const regularCents = observation.price.regularCents;
    const savePercent = regularCents > current.cents
      ? roundPercent(((regularCents - current.cents) / regularCents) * 100)
      : observation.promotion?.savePercent;
    ongoing.push({
      product: cloneJson(observation.product),
      store: cloneJson(observation.store),
      current: { ...current, observedAt: observation.lastSeenAt ?? observation.observedAt },
      regularCents,
      savePercent,
      promotion: cloneJson(observation.promotion),
    });
  }

  return ongoing.sort((left, right) => (right.savePercent ?? 0) - (left.savePercent ?? 0));
}

/**
 * Builds per-offer price histories: one series per productId+storeId pair,
 * points sorted ascending by observedAt, each priced by evaluating promotion
 * activity at that point's own observedAt. Series are sorted by productId
 * then storeId; empty input yields []. Groups whose observations all have
 * unparseable observedAt yield an empty points array (load is lenient; the
 * series itself still exists, as before).
 */
export function buildPriceSeries(observations, { pricePolicy = "public" } = {}) {
  const series = [];
  for (const [key, group] of groupObservations(observations)) {
    // Parse each observedAt once, skip unparseable rows, decorate with the
    // epoch so the ascending sort never re-parses inside a comparator.
    const timed = [];
    for (const observation of group) {
      const observedMs = Date.parse(observation.observedAt);
      if (!Number.isNaN(observedMs)) timed.push([observedMs, observation]);
    }
    timed.sort(byEpoch);

    const [productId, storeId] = key.split("\u0000");
    const points = timed.map(([observedMs, observation]) => {
      const price = selectEffectivePrice(observation, { pricePolicy, atMs: observedMs });
      return { observedAt: observation.observedAt, cents: price.cents, kind: price.kind };
    });
    series.push({ productId, storeId, points });
  }

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
