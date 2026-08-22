import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { PriceArchive } from "../src/archive.js";
import { MemoryObservationRepository } from "../src/repository.js";

function obs(overrides = {}) {
  return {
    product: {
      id: overrides.productId ?? "prod:1",
      name: overrides.productName ?? "Test Product",
      brand: "Test Brand",
      categories: ["Groceries"],
      images: [],
    },
    store: {
      id: overrides.storeId ?? "store:1",
      retailer: overrides.retailer ?? "testretailer",
      name: "Test Store",
    },
    price: {
      regularCents: overrides.regularCents ?? 1000,
      promoCents: overrides.promoCents,
      memberCents: undefined,
    },
    source: {
      retailerProductId: overrides.productId ?? "prod:1",
    },
    observedAt: overrides.observedAt ?? new Date().toISOString(),
    isOnSpecial: overrides.isOnSpecial ?? true,
    promotion: overrides.promotion ?? undefined,
    ...overrides.extra,
  };
}

describe("PriceArchive", () => {
  let archive;

  before(async () => {
    const repo = new MemoryObservationRepository();
    const now = Date.now();
    const DAY = 86400000;

    // Record some observations
    await repo.append([
      // Product 1 - with price history
      obs({ productId: "prod:1", productName: "Milk", retailer: "shoprite", storeId: "s:1",
        regularCents: 500, observedAt: new Date(now - 30 * DAY).toISOString() }),
      obs({ productId: "prod:1", productName: "Milk", retailer: "shoprite", storeId: "s:1",
        regularCents: 500, observedAt: new Date(now - 20 * DAY).toISOString() }),
      obs({ productId: "prod:1", productName: "Milk", retailer: "shoprite", storeId: "s:1",
        regularCents: 500, observedAt: new Date(now - 10 * DAY).toISOString() }),
      obs({ productId: "prod:1", productName: "Milk", retailer: "shoprite", storeId: "s:1",
        regularCents: 400, observedAt: new Date(now - 1 * DAY).toISOString() }), // drop!

      // Product 2 - ongoing promotion
      obs({ productId: "prod:2", productName: "Bread", retailer: "shoprite", storeId: "s:1",
        regularCents: 600, promoCents: 350,
        observedAt: new Date(now - 1 * DAY).toISOString(),
        promotion: { type: "SPECIAL", savePercent: 41.7, saveCents: 250 } }),

      // Product 3 - stale, no recent observation
      obs({ productId: "prod:3", productName: "Eggs", retailer: "shoprite", storeId: "s:1",
        regularCents: 800, promoCents: 650,
        observedAt: new Date(now - 30 * DAY).toISOString(),
        promotion: { type: "SPECIAL", savePercent: 18.75, saveCents: 150 } }),
    ]);
    archive = new PriceArchive(repo);
  });

  it("history() returns all observations", async () => {
    const all = await archive.history();
    assert.equal(all.length, 6);
  });

  it("history() filters by retailer", async () => {
    const results = await archive.history({ retailer: "shoprite" });
    assert.equal(results.length, 6);
  });

  it("history() returns empty for unknown retailer", async () => {
    const results = await archive.history({ retailer: "unknown" });
    assert.equal(results.length, 0);
  });

  it("findSales() returns price drops with sufficient history", async () => {
    const sales = await archive.findSales({
      minSamples: 2, baselineDays: 60, minDropPercent: 5
    });
    assert.equal(sales.length, 1);
    assert.equal(sales[0].product.name, "Milk");
    assert(sales[0].dropPercent > 0);
  });

  it("ongoingSales() returns active promotions", async () => {
    const ongoing = await archive.ongoingSales({ freshWithinDays: 7 });
    assert.equal(ongoing.length, 1);
    assert.equal(ongoing[0].product.name, "Bread");
  });

  it("agentFeed() returns feed with sales and ongoingSales", async () => {
    const feed = await archive.agentFeed({
      minSamples: 2, baselineDays: 60, minDropPercent: 5, freshDays: 7
    });
    assert.equal(feed.currency, "NZD");
    assert(feed.sales.length >= 1);
    assert(feed.ongoingSales.length >= 1);
    assert(feed.sales[0].productName === "Milk");
    assert(feed.ongoingSales[0].productName === "Bread");
  });

  it("record() appends new observations", async () => {
    const count = await archive.record([obs({ productId: "prod:4", productName: "Butter" })]);
    const all = await archive.history();
    assert.equal(all.length, 7);
  });
});

describe("PriceArchive clock injection", () => {
  // Fixed history: three $10 samples then a recent $5 observation 3 days old.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const BASE_MS = Date.parse("2026-08-20T00:00:00.000Z");

  async function makeArchive(clock) {
    const repo = new MemoryObservationRepository();
    await repo.append([
      obs({ productId: "prod:c", observedAt: new Date(BASE_MS - 30 * DAY_MS).toISOString() }),
      obs({ productId: "prod:c", observedAt: new Date(BASE_MS - 20 * DAY_MS).toISOString() }),
      obs({ productId: "prod:c", observedAt: new Date(BASE_MS - 10 * DAY_MS).toISOString() }),
      obs({
        productId: "prod:c",
        regularCents: 500,
        observedAt: new Date(BASE_MS - 3 * DAY_MS).toISOString(),
      }),
    ]);
    return new PriceArchive(repo, { clock });
  }

  it("fake clock drives findSales freshness without real time", async () => {
    // Clock pinned to BASE: the 3-day-old drop is fresh → sale reported.
    const pinned = await makeArchive(() => new Date(BASE_MS));
    const sales = await pinned.findSales({ minSamples: 2, baselineDays: 60 });
    assert.equal(sales.length, 1);
    assert.equal(sales[0].current.cents, 500);
    assert.equal(sales[0].dropPercent, 50);

    // Same data, clock advanced past the freshness window: nothing is fresh.
    const advanced = await makeArchive(() => new Date(BASE_MS + 11 * DAY_MS));
    assert.deepEqual(await advanced.findSales({ minSamples: 2, baselineDays: 60 }), []);
  });

  it("query.at still overrides the injected clock", async () => {
    const advanced = await makeArchive(() => new Date(BASE_MS + 11 * DAY_MS));
    const sales = await advanced.findSales({
      at: new Date(BASE_MS).toISOString(),
      minSamples: 2,
      baselineDays: 60,
    });
    assert.equal(sales.length, 1);
  });

  it("agentFeed stamps generatedAt from the clock", async () => {
    const pinned = await makeArchive(() => new Date(BASE_MS));
    const feed = await pinned.agentFeed({ minSamples: 2, baselineDays: 60 });
    assert.equal(feed.generatedAt, new Date(BASE_MS).toISOString());
  });
});

describe("PriceArchive behavior-change fixture [GROK-8]", () => {
  /**
   * Golden-style proof of the promotion-window fix, end to end through
   * PriceArchive.findSales. An offer carried promo cents (400 vs 1000
   * regular) under a promotion that ENDED ~25 days before "now"; its two
   * baseline samples still carry those stale promoCents. The current price
   * is an honest 900c regular.
   *
   * OLD semantics (windows ignored): baselines averaged 400c → dropPercent
   * was a nonsensical negative (-125), previousLow 400c → NOT an all-time
   * low → with any sane minDropPercent this query returned [].
   * NEW semantics: stale promo cents are excluded per-point, baselines
   * average 1000c → dropPercent 10 AND isAllTimeLow true → the deal appears.
   */
  it("stale promo cents no longer poison baselines or hide all-time lows", async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const baseMs = Date.parse("2026-08-20T00:00:00.000Z");
    const ago = (days) => new Date(baseMs - days * DAY_MS).toISOString();
    const endedPromotion = {
      type: "SPECIAL",
      savePercent: 60,
      startsAt: ago(46),
      endsAt: ago(45),
    };
    const repo = new MemoryObservationRepository();
    await repo.append([
      obs({
        productId: "prod:g",
        regularCents: 1000,
        promoCents: 400,
        observedAt: ago(30),
        promotion: endedPromotion,
      }),
      obs({
        productId: "prod:g",
        regularCents: 1000,
        promoCents: 400,
        observedAt: ago(28),
        promotion: endedPromotion,
      }),
      obs({ productId: "prod:g", regularCents: 900, observedAt: ago(2) }),
    ]);
    const archive = new PriceArchive(repo, { clock: () => new Date(baseMs) });

    const sales = await archive.findSales({ minSamples: 2, baselineDays: 90, minDropPercent: 5 });
    assert.equal(sales.length, 1); // previously 0 — deal was invisible
    assert.equal(sales[0].baseline.averageCents, 1000); // NOT 400 (old bug)
    assert.equal(sales[0].current.cents, 900);
    assert.equal(sales[0].previousLowCents, 1000); // NOT 400 (old bug)
    assert.equal(sales[0].isAllTimeLow, true); // previously false
    assert.equal(sales[0].dropPercent, 10); // previously -125
  });
});
