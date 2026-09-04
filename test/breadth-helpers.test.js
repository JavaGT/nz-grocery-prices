import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_DISCOVERY_TTL_MS,
  DEFAULT_PILOT_BUDGET,
  absorbHits,
  assertNotLiveArchive,
  discoveryFresh,
  reconcile,
  resolveStores,
} from "../scripts/lib/breadth-helpers.js";

/** One Foodstuffs product hit carrying the fields the adapter reads. */
function hit(id, price = 500) {
  return {
    productId: `${id}-EA-000`,
    name: `Product ${id}`,
    brand: "Test Brand",
    singlePrice: { price, promoId: null, comparativePrice: null },
    multiPrice: { price: null },
    price,
    promotions: [],
    decalCode: null,
    decalImageUrl: null,
    categoryTrees: [{ level0: "Pantry", level1: null, level2: null }],
    categories: null,
    unitPrice: null,
  };
}

describe("breadth-helpers", () => {
  it("pins the shared pilot budget to a finite cap", () => {
    assert.equal(Number.isInteger(DEFAULT_PILOT_BUDGET), true);
    assert.equal(DEFAULT_PILOT_BUDGET > 0, true);
  });

  it("discoveryFresh judges checkpoint age against the TTL", () => {
    const completed = new Map([["s:cat=bakery:page0", "2026-09-01T00:00:00.000Z"]]);
    const ttl = DEFAULT_DISCOVERY_TTL_MS; // 3 days

    assert.equal(discoveryFresh(completed, "s:cat=bakery:page0", "2026-09-02T00:00:00.000Z", ttl), true);
    // Exactly TTL old is stale (age < ttlMs required).
    assert.equal(discoveryFresh(completed, "s:cat=bakery:page0", "2026-09-04T00:00:00.000Z", ttl), false);
    assert.equal(discoveryFresh(completed, "s:cat=bakery:page0", "2026-09-10T00:00:00.000Z", ttl), false);
    // Unknown and malformed entries are never fresh.
    assert.equal(discoveryFresh(completed, "s:cat=missing:page0", "2026-09-02T00:00:00.000Z", ttl), false);
    const bad = new Map([["s:cat=x:page0", "not-a-date"]]);
    assert.equal(discoveryFresh(bad, "s:cat=x:page0", "2026-09-02T00:00:00.000Z", ttl), false);
    // A Date instance works as `now`.
    assert.equal(discoveryFresh(completed, "s:cat=bakery:page0", new Date("2026-09-02T00:00:00.000Z"), ttl), true);
  });

  it("assertNotLiveArchive refuses the live archive unless forced", () => {
    assert.throws(() => assertNotLiveArchive("data/prices.jsonl"), /Refusing/);
    assert.doesNotThrow(() => assertNotLiveArchive("data/breadth-pilot-fc.jsonl"));
    assert.doesNotThrow(() =>
      assertNotLiveArchive("data/prices.jsonl", { forceLive: true }),
    );
  });

  it("assertNotLiveArchive honors ARCHIVE_FILE override", () => {
    const previous = process.env.ARCHIVE_FILE;
    process.env.ARCHIVE_FILE = "data/breadth-pilot-nw.jsonl";
    try {
      assert.throws(
        () => assertNotLiveArchive("data/breadth-pilot-nw.jsonl"),
        /Refusing/,
      );
    } finally {
      if (previous === undefined) delete process.env.ARCHIVE_FILE;
      else process.env.ARCHIVE_FILE = previous;
    }
  });

  it("dedupes hits by productId keeping first sight", () => {
    const seen = new Map();
    const first = absorbHits(seen, [
      hit("5004821", 860),
      { name: "no id" },
    ]);
    assert.equal(first.length, 1);
    const second = absorbHits(seen, [hit("5004821", 999), hit("6000001")]);
    // Keep-first: the second sighting (price 999) must not win.
    assert.deepEqual(second.map((product) => product.productId), ["6000001-EA-000"]);
    assert.equal(seen.get("5004821-EA-000").singlePrice.price, 860);
  });

  it("reconciles coverage against the catalogue target", () => {
    assert.deepEqual(reconcile(10, undefined), {
      target: undefined,
      delta: undefined,
      deltaRatio: undefined,
      withinTolerance: true,
    });
    assert.equal(reconcile(9445, 9445).withinTolerance, true);
    assert.equal(reconcile(9443, 9445).withinTolerance, true); // ~0.02% under
    assert.equal(reconcile(9390, 9445).withinTolerance, false); // ~0.58% under
    assert.equal(reconcile(9520, 9445).withinTolerance, false); // ~0.79% over
    assert.equal(reconcile(0, 0).withinTolerance, true);
  });

  const allStores = [
    { id: "s-1", name: "PAK'nSAVE Testville", address: "1 Test Road" },
    { id: "s-2", name: "New World Testville", address: "2 Test Road" },
    { id: "s-3", name: "PAK'nSAVE Harbour", address: "3 Harbour Quay" },
  ];

  it("resolveStores prefers exact id, then exact name, then unique substring", () => {
    assert.equal(resolveStores(["s-2"], allStores)[0].name, "New World Testville");
    assert.equal(resolveStores(["pak'nsave testville"], allStores)[0].id, "s-1");
    assert.equal(resolveStores(["harbour"], allStores)[0].id, "s-3");
  });

  it("resolveStores throws on ambiguous and unmatched queries", () => {
    assert.throws(() => resolveStores(["testville"], allStores), /ambiguous/);
    assert.throws(() => resolveStores(["nowhere"], allStores), /No store matches/);
  });
});
