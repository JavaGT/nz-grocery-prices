import { describe, it } from "node:test";
import assert from "node:assert/strict";

const DAY_MS = 24 * 60 * 60 * 1000;

// Fixed anchor so window/boundary tests are fully deterministic.
const BASE_MS = Date.parse("2026-08-20T12:00:00.000Z");

/** ISO timestamp offset from the fixed base by `offsetMs` milliseconds. */
function iso(offsetMs) {
  return new Date(BASE_MS + offsetMs).toISOString();
}

/** Minimal observation at a fixed absolute time (analytics needs no source). */
function obsAt(observedAtOffsetMs, overrides = {}) {
  return {
    product: { id: "p:1", name: "P", brand: "B", categories: [], images: [] },
    store: { id: "s:1", retailer: "testretailer", name: "S" },
    price: { regularCents: 1000 },
    observedAt: iso(observedAtOffsetMs),
    isOnSpecial: true,
    ...overrides,
  };
}

/** Observation relative to the fixed BASE_MS anchor; daysAgo may be fractional. */
function makeObs(overrides = {}) {
  const observedAtMs = BASE_MS - (overrides.daysAgo || 0) * DAY_MS;
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
    observedAt: new Date(observedAtMs).toISOString(),
    isOnSpecial: overrides.isOnSpecial ?? true,
    promotion: overrides.promotion ?? undefined,
    ...overrides
  };
}

/** Promotion window spanning [startOffsetMs, endOffsetMs] around BASE_MS. */
function windowAround(startOffsetMs, endOffsetMs) {
  return {
    type: "SPECIAL",
    savePercent: 25,
    startsAt: iso(startOffsetMs),
    endsAt: iso(endOffsetMs),
  };
}

import {
  buildPriceSeries,
  calculateOngoingSales,
  calculateSales,
  toAgentFeed,
} from "../src/analytics.js";

describe("calculateSales", () => {
  it("throws TypeError when at is missing (deterministic contract)", () => {
    assert.throws(
      () => calculateSales([makeObs({ daysAgo: 0 })]),
      /calculateSales requires an explicit at/
    );
  });

  it("throws TypeError for a non-parseable at", () => {
    assert.throws(
      () => calculateSales([makeObs({ daysAgo: 0 })], { at: "not-a-date" }),
      TypeError
    );
  });

  it("skips observations with unparseable observedAt instead of crashing", () => {
    // Load is lenient [GROK-4]; garbage timestamps must not win the sort
    // (NaN comparator) or poison the series.
    const obs = [
      makeObs({ daysAgo: 12, price: { regularCents: 1000 } }),
      makeObs({ daysAgo: 8, price: { regularCents: 1000 } }),
      { ...makeObs(), observedAt: "garbage" },
      makeObs({ daysAgo: 0, price: { regularCents: 800 } }),
    ];
    const sales = calculateSales(obs, { at: iso(0), minDropPercent: 5 });
    assert.equal(sales.length, 1);
    assert.equal(sales[0].current.cents, 800);
  });

  it("returns empty array for single observation (need >1)", () => {
    const obs = [makeObs({ daysAgo: 0 })];
    const sales = calculateSales(obs, { at: iso(0) });
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
    const sales = calculateSales(obs, { at: iso(0), minDropPercent: 5, baselineDays: 60, minSamples: 2 });
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
    const sales = calculateSales(obs, { at: iso(0), minDropPercent: 5, minSamples: 2, includeAllTimeLows: false });
    assert.equal(sales.length, 0);
  });

  it("detects all-time low even below minDropPercent if enabled", () => {
    const obs = [
      makeObs({ daysAgo: 10, price: { regularCents: 1000 } }),
      makeObs({ daysAgo: 0, price: { regularCents: 990 } }),
    ];
    const sales = calculateSales(obs, { at: iso(0), minDropPercent: 10, minSamples: 2 });
    // 1% drop, below 10% threshold, not an all-time low (1000 > 990)
    assert.equal(sales.length, 0);
  });

  it("uses promotion price for effective price", () => {
    const obs = [
      makeObs({ daysAgo: 10, price: { regularCents: 1000 } }),
      makeObs({ daysAgo: 5, price: { regularCents: 1000 } }),
      makeObs({ daysAgo: 0, price: { regularCents: 1000, promoCents: 750 } }),
    ];
    const sales = calculateSales(obs, { at: iso(0), minDropPercent: 5, minSamples: 2 });
    assert.equal(sales.length, 1);
    assert.equal(sales[0].current.cents, 750);
  });
});

describe("calculateOngoingSales", () => {
  it("throws TypeError when at is missing", () => {
    assert.throws(
      () => calculateOngoingSales([makeObs({ daysAgo: 1 })]),
      /calculateOngoingSales requires an explicit at/
    );
  });

  it("throws TypeError for a non-parseable at", () => {
    assert.throws(
      () => calculateOngoingSales([], { at: 42 }),
      /requires an explicit at/
    );
  });

  it("returns promotion observations with active promos", () => {
    const obs = [
      makeObs({
        daysAgo: 1,
        price: { regularCents: 1000, promoCents: 700 },
        promotion: { type: "SPECIAL", savePercent: 30 },
      }),
    ];
    const sales = calculateOngoingSales(obs, { at: iso(0) });
    assert.equal(sales.length, 1);
    assert.equal(sales[0].current.cents, 700);
  });

  it("excludes items without promotion price", () => {
    const obs = [
      makeObs({ daysAgo: 1, price: { regularCents: 1000 } }), // no promoCents
    ];
    const sales = calculateOngoingSales(obs, { at: iso(0) });
    assert.equal(sales.length, 0);
  });

  it("excludes stale observations beyond freshWithinDays", () => {
    const obs = [
      makeObs({ daysAgo: 30, price: { regularCents: 1000, promoCents: 700 } }),
    ];
    const sales = calculateOngoingSales(obs, { at: iso(0), freshWithinDays: 7 });
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

describe("calculateSales — ordering and windows", () => {
  it("detects the sale when input arrives reverse-chronologically", () => {
    // Previously the last array element was treated as "current"; unsorted
    // input made analytics compare against the wrong end of the history.
    const obs = [
      makeObs({ daysAgo: 1, price: { regularCents: 800 } }),
      makeObs({ daysAgo: 20, price: { regularCents: 1000 } }),
      makeObs({ daysAgo: 25, price: { regularCents: 1000 } }),
      makeObs({ daysAgo: 30, price: { regularCents: 1000 } }),
    ];
    const sales = calculateSales(obs, { at: iso(0), minDropPercent: 5, baselineDays: 60, minSamples: 2 });
    assert.equal(sales.length, 1);
    assert.equal(sales[0].current.cents, 800);
    assert.equal(sales[0].baseline.sampleCount, 3);
  });

  it("treats duplicate-timestamp observations as insertion-order stable", () => {
    // Equal timestamps keep input order (stable sort): the later-inserted
    // 900c observation is "current", the earlier 1000c one joins the baseline.
    const stamp = iso(-2 * DAY_MS);
    const obs = [
      makeObs({ daysAgo: 10, price: { regularCents: 1000 } }),
      makeObs({ daysAgo: 10, price: { regularCents: 1000 } }),
      { ...makeObs({ price: { regularCents: 1000 } }), observedAt: stamp },
      { ...makeObs({ price: { regularCents: 900 } }), observedAt: stamp },
    ];
    const sales = calculateSales(obs, { at: iso(0), minSamples: 2 });
    assert.equal(sales.length, 1);
    assert.equal(sales[0].current.cents, 900);
    assert.deepEqual(sales[0].baseline.averageCents, 1000);
  });

  /**
   * [GROK-8] Behavior-change golden fixture. A product whose promotional
   * pricing ENDED long before the recent baseline samples: every baseline
   * observation still carries promoCents=400 plus the expired window, and
   * the current observation is a plain 800c regular price.
   *
   * OLD semantics (windows ignored): baselines averaged 400c, so the real
   * 20% drop read as -100% → NO deal surfaced at all.
   * NEW semantics (per-point evaluation): expired promo cents are ignored,
   * baselines average 1000c → a genuine 20% drop is reported.
   */
  it("baselines at REGULAR cents once a promotion window has expired [GROK-8]", () => {
    const expiredPromoWindow = {
      type: "SPECIAL",
      savePercent: 60,
      startsAt: iso(-45 * DAY_MS),
      endsAt: iso(-40 * DAY_MS), // ended 10+ days before any baseline sample
    };
    const obs = [
      makeObs({
        daysAgo: 30,
        price: { regularCents: 1000, promoCents: 400 },
        promotion: expiredPromoWindow,
      }),
      makeObs({
        daysAgo: 25,
        price: { regularCents: 1000, promoCents: 400 },
        promotion: expiredPromoWindow,
      }),
      makeObs({ daysAgo: 1, price: { regularCents: 800 } }), // honest new price
    ];
    const sales = calculateSales(obs, { at: iso(0), minDropPercent: 5 });
    assert.equal(sales.length, 1);
    assert.equal(sales[0].baseline.averageCents, 1000); // NOT 400 (old bug)
    assert.equal(sales[0].baseline.sampleCount, 2);
    assert.equal(sales[0].current.cents, 800);
    assert.equal(sales[0].dropPercent, 20); // previously -100 → sale invisible
  });

  it("counts promo cents for baseline points inside their own window", () => {
    const obs = [
      makeObs({
        daysAgo: 10,
        price: { regularCents: 1000, promoCents: 600 },
        promotion: windowAround(-10.5 * DAY_MS, -9.5 * DAY_MS), // covers the point
      }),
      makeObs({ daysAgo: 7, price: { regularCents: 1200 } }),
      makeObs({ daysAgo: 5, price: { regularCents: 1000 } }),
      makeObs({
        daysAgo: 0,
        price: { regularCents: 1000, promoCents: 700 },
        promotion: windowAround(-DAY_MS, DAY_MS),
      }),
    ];
    const sales = calculateSales(obs, { at: iso(0), minDropPercent: 5, minSamples: 3 });
    // Baseline avg = (600 + 1200 + 1000) / 3 ≈ 933; current 700 → ~25% drop.
    assert.equal(sales.length, 1);
    assert.equal(sales[0].baseline.averageCents, 933);
    assert.equal(sales[0].current.cents, 700);
    assert.equal(sales[0].current.kind, "promo");
  });

  it("member cents are excluded under the default public policy", () => {
    const obs = [
      makeObs({ daysAgo: 10, price: { regularCents: 1000 } }),
      makeObs({ daysAgo: 5, price: { regularCents: 1000 } }),
      makeObs({ daysAgo: 0, price: { regularCents: 1000, memberCents: 500 } }),
    ];
    const sales = calculateSales(obs, { at: iso(0), minDropPercent: 5, minSamples: 2 });
    assert.equal(sales.length, 0); // member price invisible to public policy
  });

  it("member cents apply under the member policy", () => {
    const obs = [
      makeObs({ daysAgo: 10, price: { regularCents: 1000 } }),
      makeObs({ daysAgo: 5, price: { regularCents: 1000 } }),
      makeObs({ daysAgo: 0, price: { regularCents: 1000, memberCents: 500 } }),
    ];
    const sales = calculateSales(obs, { at: iso(0), pricePolicy: "member", minDropPercent: 5, minSamples: 2 });
    assert.equal(sales.length, 1);
    assert.equal(sales[0].current.cents, 500);
    assert.equal(sales[0].current.kind, "member");
  });

  it("does not report an all-time low on a tie with the previous low", () => {
    const obs = [
      makeObs({ daysAgo: 10, price: { regularCents: 900 } }),
      makeObs({ daysAgo: 5, price: { regularCents: 1000 } }),
      makeObs({ daysAgo: 0, price: { regularCents: 900 } }),
    ];
    const sales = calculateSales(obs, { at: iso(0), minDropPercent: 0 });
    assert.equal(sales.length, 1); // still a sale via ATL inclusion…
    assert.equal(sales[0].isAllTimeLow, false); // …but equal low is NOT an ATL
  });

  it("returns [] for empty input and single samples below minSamples", () => {
    assert.deepEqual(calculateSales([], { at: iso(0) }), []);
    assert.deepEqual(
      calculateSales([makeObs({ daysAgo: 0 })], { at: iso(0), minSamples: 2 }),
      []
    );
  });
});

describe("buildPriceSeries", () => {
  it("returns [] for empty input", () => {
    assert.deepEqual(buildPriceSeries([]), []);
  });

  it("splits one product across stores into separate sorted series", () => {
    const series = buildPriceSeries([
      obsAt(0, { store: { id: "s:2", retailer: "r", name: "S2" }, price: { regularCents: 900 } }),
      obsAt(-DAY_MS, { price: { regularCents: 1000 } }),
      obsAt(0, { price: { regularCents: 800 } }),
      obsAt(-DAY_MS, { store: { id: "s:2", retailer: "r", name: "S2" }, price: { regularCents: 950 } }),
    ]);
    assert.equal(series.length, 2);
    const [store1, store2] = series;
    assert.equal(store1.productId, "p:1");
    assert.equal(store1.storeId, "s:1");
    assert.deepEqual(store1.points.map((p) => p.cents), [1000, 800]);
    assert.equal(store2.storeId, "s:2");
    assert.deepEqual(store2.points.map((p) => p.cents), [950, 900]);
    assert.ok(store1.points[0].observedAt < store1.points[1].observedAt);
  });

  it("sorts output series by productId then storeId regardless of input order", () => {
    const otherProduct = { id: "a:1", name: "A", brand: "B", categories: [], images: [] };
    const series = buildPriceSeries([
      obsAt(0, { product: otherProduct, store: { id: "z:1", retailer: "r", name: "Z" } }),
      obsAt(0),
    ]);
    assert.deepEqual(
      series.map((s) => `${s.productId}@${s.storeId}`),
      ["a:1@z:1", "p:1@s:1"]
    );
  });

  it("applies promotion windows inclusive of both boundaries per point", () => {
    const promoPrice = { regularCents: 1000, promoCents: 500 };
    const series = buildPriceSeries([
      // Exactly endsAt: still active → promo.
      obsAt(DAY_MS, {
        price: promoPrice,
        promotion: windowAround(-DAY_MS, DAY_MS),
      }),
      // endsAt + 1ms: expired → falls back to regular.
      obsAt(DAY_MS + 1, { price: promoPrice, promotion: windowAround(-DAY_MS, DAY_MS) }),
      // Exactly startsAt: active → promo.
      obsAt(-DAY_MS, { price: promoPrice, promotion: windowAround(-DAY_MS, DAY_MS) }),
      // startsAt - 1ms: not yet active → regular.
      obsAt(-DAY_MS - 1, { price: promoPrice, promotion: windowAround(-DAY_MS, DAY_MS) }),
      // No window fields: legacy always-active promo.
      obsAt(2 * DAY_MS, { price: promoPrice, promotion: { type: "SPECIAL" } }),
    ]);
    assert.deepEqual(
      series[0].points.map((p) => [p.kind, p.cents]),
      [
        ["regular", 1000], // startsAt - 1ms: not yet active
        ["promo", 500],    // exactly startsAt: inclusive
        ["promo", 500],    // exactly endsAt: inclusive
        ["regular", 1000], // endsAt + 1ms: expired
        ["promo", 500],    // no window fields: legacy always-active promo
      ]
    );
  });

  it("unsorted input produces identical output to pre-sorted input", () => {
    const make = () => [
      obsAt(2 * DAY_MS, { price: { regularCents: 700 } }),
      obsAt(-DAY_MS, { price: { regularCents: 1000 } }),
      obsAt(0, { price: { regularCents: 900 } }),
      obsAt(DAY_MS, { price: { regularCents: 800 } }),
    ];
    const shuffled = [...make()].reverse();
    assert.deepEqual(buildPriceSeries(shuffled), buildPriceSeries(make()));
  });

  it("honors the member price policy in series points", () => {
    const series = buildPriceSeries(
      [obsAt(0, { price: { regularCents: 1000, memberCents: 600 } })],
      { pricePolicy: "member" }
    );
    assert.deepEqual(series[0].points, [{
      observedAt: iso(0),
      cents: 600,
      kind: "member",
    }]);
  });

  it("compares offset-form ISO windows numerically (non-Z timestamps)", () => {
    // NZ offset (+12:00) instants must parse to absolute times, not be
    // string-compared: "2026-08-20T23:59:59+12:00" === 2026-08-20T11:59:59Z.
    const startsAt = "2026-08-20T10:00:00.000+12:00"; // = 2026-08-19T22:00:00Z
    const endsAt = "2026-08-21T22:00:00.000+12:00";   // = 2026-08-21T10:00:00Z
    const promoPrice = { regularCents: 1000, promoCents: 500 };
    const window = { type: "SPECIAL", savePercent: 50, startsAt, endsAt };
    // BASE_MS is 2026-08-20T12:00:00Z; offsets below are relative to it.
    const startMsZ = Date.parse(startsAt);
    const endMsZ = Date.parse(endsAt);
    const rel = (ms) => ms - BASE_MS;
    const series = buildPriceSeries([
      obsAt(rel(startMsZ), { price: promoPrice, promotion: window }),      // exactly startsAt
      obsAt(rel(endMsZ), { price: promoPrice, promotion: window }),        // exactly endsAt
      obsAt(rel(endMsZ + 1), { price: promoPrice, promotion: window }),    // endsAt + 1ms
      obsAt(rel(startMsZ - 1), { price: promoPrice, promotion: window }),  // startsAt - 1ms
    ]);
    assert.deepEqual(
      series[0].points.map((p) => [p.kind, p.cents]),
      [
        ["regular", 1000], // startsAt - 1ms
        ["promo", 500],    // exactly startsAt: inclusive via numeric comparison
        ["promo", 500],    // exactly endsAt: inclusive via numeric comparison
        ["regular", 1000], // endsAt + 1ms
      ]
    );
  });
});

describe("calculateOngoingSales — windows and edge cases", () => {
  it("includes a promo exactly at endsAt and excludes it after end date+1ms", () => {
    const active = [makeObs({
      daysAgo: 1,
      price: { regularCents: 1000, promoCents: 700 },
      promotion: windowAround(-2 * DAY_MS, 0),
    })];
    const atEnd = calculateOngoingSales(active, { at: iso(0) });
    assert.equal(atEnd.length, 1);

    const justAfter = calculateOngoingSales(active, { at: iso(1) }); // endsAt+1ms
    assert.equal(justAfter.length, 0);
  });

  it("uses only the latest observation per offer under unsorted input", () => {
    const obs = [
      makeObs({
        daysAgo: 3,
        price: { regularCents: 1000, promoCents: 400 },
        promotion: { type: "SPECIAL" },
      }),
      makeObs({
        daysAgo: 1,
        price: { regularCents: 1000, promoCents: 800 },
        promotion: { type: "SPECIAL" },
      }),
    ];
    const shuffled = [...obs].reverse();
    for (const input of [obs, shuffled]) {
      const sales = calculateOngoingSales(input, { at: iso(0) });
      assert.equal(sales.length, 1);
      assert.equal(sales[0].current.cents, 800); // newest observation wins
    }
  });

  it("returns [] for empty input", () => {
    assert.deepEqual(calculateOngoingSales([], { at: iso(0) }), []);
  });

  it("ignores future-dated observations beyond query.at", () => {
    const obs = [
      makeObs({
        daysAgo: -10, // 10 days in the future relative to BASE_MS
        price: { regularCents: 1000, promoCents: 700 },
        promotion: { type: "SPECIAL" },
      }),
    ];
    const sales = calculateOngoingSales(obs, { at: iso(0) });
    assert.equal(sales.length, 0);
  });
});
