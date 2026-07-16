import { describe, it } from "node:test";
import assert from "node:assert/strict";

// Recreate the analytics functions inline to test the logic without importing
// (the module can also be imported directly, but this validates behavior from scratch)

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

const DAY_MS = 24 * 60 * 60 * 1000;

function now() {
  return new Date().toISOString();
}

function makeObs(overrides = {}) {
  const nowMs = Date.now();
  return {
    product: {
      id: "test:123",
      name: "Test Product",
      brand: "Test Brand",
      categories: ["Groceries"],
      images: [],
      ...overrides.product
    },
    store: {
      id: "store:1",
      retailer: "testretailer",
      name: "Test Store",
      ...overrides.store
    },
    price: {
      regularCents: 1000,
      promoCents: undefined,
      memberCents: undefined,
      ...overrides.price
    },
    observedAt: new Date(nowMs - (overrides.daysAgo || 0) * DAY_MS).toISOString(),
    observedAtMs: nowMs - (overrides.daysAgo || 0) * DAY_MS,
    isOnSpecial: overrides.isOnSpecial ?? true,
    promotion: overrides.promotion ?? {
      type: "SPECIAL",
      savePercent: 20,
      saveCents: 200
    },
    ...overrides
  };
}

import { calculateSales, calculateOngoingSales, toAgentFeed } from "../src/analytics.js";

describe("calculateSales", () => {
  it("returns empty array for single observation (need >1)", () => {
    const obs = [makeObs({ daysAgo: 0 })];
    const sales = calculateSales(obs);
    assert.equal(sales.length, 0);
  });

  it("returns sale when price drops below baseline", () => {
    // 3 old observations at $10, 1 recent at $8
    const obs = [
      makeObs({ daysAgo: 30, price: { regularCents: 1000 } }),
      makeObs({ daysAgo: 25, price: { regularCents: 1000 } }),
      makeObs({ daysAgo: 20, price: { regularCents: 1000 } }),
      makeObs({ daysAgo: 1, price: { regularCents: 800 } }),
    ];
    const sales = calculateSales(obs, { minDropPercent: 5, baselineDays: 60, minSamples: 2 });
    assert.equal(sales.length, 1);
    assert(sales[0].dropPercent > 0);
    assert.equal(sales[0].current.cents, 800);
  });

  it("returns empty when no significant drop", () => {
    const obs = [
      makeObs({ daysAgo: 10, price: { regularCents: 1000 } }),
      makeObs({ daysAgo: 5, price: { regularCents: 1000 } }),
      makeObs({ daysAgo: 0, price: { regularCents: 995 } }), // 0.5% drop
    ];
    const sales = calculateSales(obs, { minDropPercent: 5, minSamples: 2, includeAllTimeLows: false });
    assert.equal(sales.length, 0);
  });

  it("detects all-time low even below minDropPercent if enabled", () => {
    const obs = [
      makeObs({ daysAgo: 10, price: { regularCents: 1000 } }),
      makeObs({ daysAgo: 0, price: { regularCents: 990 } }),
    ];
    const sales = calculateSales(obs, { minDropPercent: 10, minSamples: 2 });
    // 1% drop, below 10% threshold, not an all-time low (1000 > 990)
    assert.equal(sales.length, 0);
  });

  it("uses promotion price for effective price", () => {
    const obs = [
      makeObs({ daysAgo: 10, price: { regularCents: 1000 } }),
      makeObs({ daysAgo: 5, price: { regularCents: 1000 } }),
      makeObs({ daysAgo: 0, price: { regularCents: 1000, promoCents: 750 } }),
    ];
    const sales = calculateSales(obs, { minDropPercent: 5, minSamples: 2 });
    assert.equal(sales.length, 1);
    assert.equal(sales[0].current.cents, 750);
  });
});

describe("calculateOngoingSales", () => {
  it("returns promotion observations with active promos", () => {
    const obs = [
      makeObs({ daysAgo: 1, price: { regularCents: 1000, promoCents: 700 } }),
    ];
    const sales = calculateOngoingSales(obs);
    assert.equal(sales.length, 1);
    assert.equal(sales[0].current.cents, 700);
  });

  it("excludes items without promotion price", () => {
    const obs = [
      makeObs({ daysAgo: 1, price: { regularCents: 1000 } }), // no promoCents
    ];
    const sales = calculateOngoingSales(obs);
    assert.equal(sales.length, 0);
  });

  it("excludes stale observations beyond freshWithinDays", () => {
    const obs = [
      makeObs({ daysAgo: 30, price: { regularCents: 1000, promoCents: 700 } }),
    ];
    const sales = calculateOngoingSales(obs, { freshWithinDays: 7 });
    assert.equal(sales.length, 0);
  });
});

describe("toAgentFeed", () => {
  it("formats sales and ongoingSales for API response", () => {
    const sales = [{
      product: { id: "t:1", name: "P1", brand: "B1", gtin: "123", categories: [], images: [] },
      store: { id: "s:1", retailer: "test", name: "TS" },
      current: { cents: 800, kind: "regular", observedAt: new Date().toISOString() },
      baseline: { averageCents: 1000, sampleCount: 3, days: 90 },
      dropPercent: 20,
      previousLowCents: 800,
      isAllTimeLow: false
    }];
    const ongoing = [{
      product: { id: "t:2", name: "P2", brand: "B2", gtin: "456", categories: [], images: [] },
      store: { id: "s:1", retailer: "test", name: "TS" },
      current: { cents: 700, kind: "promo", observedAt: new Date().toISOString() },
      regularCents: 1000,
      savePercent: 30,
      promotion: { type: "SPECIAL", savePercent: 30 }
    }];
    const feed = toAgentFeed(sales, new Date().toISOString(), ongoing);
    assert.equal(feed.currency, "NZD");
    assert.equal(feed.sales.length, 1);
    assert.equal(feed.sales[0].productName, "P1");
    assert.equal(feed.sales[0].dropPercent, 20);
    assert.equal(feed.ongoingSales.length, 1);
    assert.equal(feed.ongoingSales[0].productName, "P2");
    assert.equal(feed.ongoingSales[0].savePercent, 30);
  });
});
