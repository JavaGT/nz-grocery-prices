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
