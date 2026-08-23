import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { JsonlObservationRepository } from "../src/repository.js";
import { ArchiveIndex } from "../src/archive-index.js";

// ---- deterministic fixture helpers ---------------------------------------

function obs(o) {
  return {
    product: {
      id: o.productId,
      name: o.productName ?? `Product ${o.productId}`,
    },
    store: {
      id: o.storeId,
      retailer: o.retailer,
      ...(o.suburb ? { suburb: o.suburb } : {}),
    },
    price: {
      regularCents: o.regularCents ?? 500,
      ...(o.promoCents !== undefined ? { promoCents: o.promoCents } : {}),
    },
    source: { retailerProductId: o.sourceId },
    observedAt: o.observedAt,
  };
}

/**
 * Expected shape of a materialized query observation: product/store come
 * from the revisions in effect at the DISPLAY time, `seen` marks an offer
 * active in the specials listing (lastSeenAt + isOnSpecial: true), `known`
 * without `seen` marks one absent from a known listing (isOnSpecial: false),
 * and neither means the store has no listing knowledge at all.
 */
function expect(o) {
  return {
    product: { id: o.id, name: o.name },
    store: o.suburb === undefined
      ? { id: o.store, retailer: o.retailer }
      : { id: o.store, retailer: o.retailer, suburb: o.suburb },
    price: o.promoCents === undefined
      ? { regularCents: o.cents }
      : { regularCents: o.cents, promoCents: o.promoCents },
    observedAt: o.at,
    ...(o.seen ? { lastSeenAt: o.seen, isOnSpecial: true } : {}),
    ...(o.seen || o.known ? { isOnSpecial: o.seen ? true : false } : {}),
    source: { retailerProductId: o.src },
  };
}

/** Runs the CORE-3 parity scenario: 7 deterministic append batches. */
async function runFixture(repository) {
  // Day 1: initial collections across two stores / two retailers.
  await repository.append([
    obs({ productId: "p1", storeId: "s-nw-alb", retailer: "newworld", sourceId: "nw-1", observedAt: "2026-08-10T01:00:00.000Z", regularCents: 349, promoCents: 299 }),
    obs({ productId: "p2", storeId: "s-nw-alb", retailer: "newworld", sourceId: "nw-2", observedAt: "2026-08-10T01:00:00.000Z", regularCents: 550 }),
    obs({ productId: "p2", storeId: "s-pns-mt", retailer: "paknsave", suburb: "Mt Roskill", sourceId: "pns-2", observedAt: "2026-08-10T01:30:00.000Z", regularCents: 450 }),
  ], { snapshotScope: "specials" });
  // Day 2: price change on p1@nw-alb; p2@nw-alb deduped (same content).
  await repository.append([
    obs({ productId: "p1", storeId: "s-nw-alb", retailer: "newworld", sourceId: "nw-1", observedAt: "2026-08-11T01:00:00.000Z", regularCents: 399 }),
    obs({ productId: "p2", storeId: "s-nw-alb", retailer: "newworld", sourceId: "nw-2", observedAt: "2026-08-11T01:00:00.000Z", regularCents: 550 }),
    obs({ productId: "p2", storeId: "s-pns-mt", retailer: "paknsave", suburb: "Mt Roskill", sourceId: "pns-2", observedAt: "2026-08-11T01:30:00.000Z", regularCents: 425 }),
  ], { snapshotScope: "specials" });
  // Day 3: STORE REVISION — retailer CHANGE for s-nw-alb (GROK-7 trap):
  // earlier offers must keep materializing with the historical retailer.
  await repository.append([
    obs({ productId: "p1", storeId: "s-nw-alb", retailer: "woolworths", suburb: "Albany", sourceId: "nw-1", observedAt: "2026-08-12T09:00:00.000Z", regularCents: 399 }),
  ]);
  // Day 4: product revision for p1 (rename); p3 listed. The day-4 snapshot
  // for s-nw-alb covers only p1, so p2@nw-alb LEAVES the listing.
  await repository.append([
    obs({ productId: "p1", productName: "Milk 2L fresh", storeId: "s-nw-alb", retailer: "woolworths", suburb: "Albany", sourceId: "nw-1", observedAt: "2026-08-13T01:00:00.000Z", regularCents: 399 }),
    obs({ productId: "p3", storeId: "s-pns-mt", retailer: "paknsave", suburb: "Mt Roskill", sourceId: "pns-3", observedAt: "2026-08-13T01:30:00.000Z", regularCents: 620 }),
  ], { snapshotScope: "specials" });
  // Out-of-order append: an Aug-9 observation arriving AFTER Aug 13.
  await repository.append([
    obs({ productId: "p1", storeId: "s-pns-mt", retailer: "paknsave", suburb: "Mt Roskill", sourceId: "pns-late", observedAt: "2026-08-09T05:00:00.000Z", regularCents: 320 }),
  ]);
  // Equal timestamps: two distinct offers observed at the same millisecond.
  await repository.append([
    obs({ productId: "p4", storeId: "s-wgtn", retailer: "woolworths", suburb: "Wellington", sourceId: "wg-4a", observedAt: "2026-08-14T00:00:00.000Z", regularCents: 700 }),
    obs({ productId: "p5", storeId: "s-wgtn", retailer: "woolworths", suburb: "Wellington", sourceId: "wg-5a", observedAt: "2026-08-14T00:00:00.000Z", regularCents: 800 }),
  ], { snapshotScope: "specials" });
  // Final collection day: drops p2 from the s-pns-mt listing.
  await repository.append([
    obs({ productId: "p3", storeId: "s-pns-mt", retailer: "paknsave", suburb: "Mt Roskill", sourceId: "pns-3", observedAt: "2026-08-15T01:30:00.000Z", regularCents: 620 }),
  ], { snapshotScope: "specials" });
}

describe("CORE-3 parity: query materialization (via JsonlObservationRepository)", () => {
  let repository;
  let directory;

  before(async () => {
    directory = await mkdtemp(join(tmpdir(), "core3-parity-"));
    repository = new JsonlObservationRepository(join(directory, "archive.jsonl"));
    await runFixture(repository);
  });

  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("query({}) materializes every offer with display-time revisions", async () => {
    assert.deepEqual(await repository.query({}), [
      // Backfilled product/store anchors make the older offer queryable.
      expect({ id: "p1", name: "Product p1", store: "s-pns-mt", retailer: "paknsave", suburb: "Mt Roskill", cents: 320, at: "2026-08-09T05:00:00.000Z", known: true, src: "pns-late" }),
      // Listed offers render at lastSeenAt (2026-08-13): latest product name
      // AND the CHANGED retailer/suburb — current semantics.
      expect({ id: "p1", name: "Milk 2L fresh", store: "s-nw-alb", retailer: "woolworths", suburb: "Albany", cents: 349, promoCents: 299, at: "2026-08-10T01:00:00.000Z", seen: "2026-08-13T01:00:00.000Z", src: "nw-1" }),
      // Removed from the day-4 listing: falls back to its own observedAt,
      // so it keeps the HISTORICAL retailer (newworld, no suburb yet).
      expect({ id: "p2", name: "Product p2", store: "s-nw-alb", retailer: "newworld", cents: 550, at: "2026-08-10T01:00:00.000Z", known: true, src: "nw-2" }),
      expect({ id: "p2", name: "Product p2", store: "s-pns-mt", retailer: "paknsave", suburb: "Mt Roskill", cents: 450, at: "2026-08-10T01:30:00.000Z", known: true, src: "pns-2" }),
      expect({ id: "p1", name: "Milk 2L fresh", store: "s-nw-alb", retailer: "woolworths", suburb: "Albany", cents: 399, at: "2026-08-11T01:00:00.000Z", seen: "2026-08-13T01:00:00.000Z", src: "nw-1" }),
      expect({ id: "p2", name: "Product p2", store: "s-pns-mt", retailer: "paknsave", suburb: "Mt Roskill", cents: 425, at: "2026-08-11T01:30:00.000Z", known: true, src: "pns-2" }),
      expect({ id: "p3", name: "Product p3", store: "s-pns-mt", retailer: "paknsave", suburb: "Mt Roskill", cents: 620, at: "2026-08-13T01:30:00.000Z", seen: "2026-08-15T01:30:00.000Z", src: "pns-3" }),
      expect({ id: "p4", name: "Product p4", store: "s-wgtn", retailer: "woolworths", suburb: "Wellington", cents: 700, at: "2026-08-14T00:00:00.000Z", seen: "2026-08-14T00:00:00.000Z", src: "wg-4a" }),
      expect({ id: "p5", name: "Product p5", store: "s-wgtn", retailer: "woolworths", suburb: "Wellington", cents: 800, at: "2026-08-14T00:00:00.000Z", seen: "2026-08-14T00:00:00.000Z", src: "wg-5a" }),
    ]);
  });

  it("query({productId}) filters post-materialization", async () => {
    assert.deepEqual(await repository.query({ productId: "p1" }), [
      expect({ id: "p1", name: "Product p1", store: "s-pns-mt", retailer: "paknsave", suburb: "Mt Roskill", cents: 320, at: "2026-08-09T05:00:00.000Z", known: true, src: "pns-late" }),
      expect({ id: "p1", name: "Milk 2L fresh", store: "s-nw-alb", retailer: "woolworths", suburb: "Albany", cents: 349, promoCents: 299, at: "2026-08-10T01:00:00.000Z", seen: "2026-08-13T01:00:00.000Z", src: "nw-1" }),
      expect({ id: "p1", name: "Milk 2L fresh", store: "s-nw-alb", retailer: "woolworths", suburb: "Albany", cents: 399, at: "2026-08-11T01:00:00.000Z", seen: "2026-08-13T01:00:00.000Z", src: "nw-1" }),
    ]);
  });

  it("query({storeId}) filters post-materialization", async () => {
    assert.deepEqual(await repository.query({ storeId: "s-nw-alb" }), [
      expect({ id: "p1", name: "Milk 2L fresh", store: "s-nw-alb", retailer: "woolworths", suburb: "Albany", cents: 349, promoCents: 299, at: "2026-08-10T01:00:00.000Z", seen: "2026-08-13T01:00:00.000Z", src: "nw-1" }),
      expect({ id: "p2", name: "Product p2", store: "s-nw-alb", retailer: "newworld", cents: 550, at: "2026-08-10T01:00:00.000Z", known: true, src: "nw-2" }),
      expect({ id: "p1", name: "Milk 2L fresh", store: "s-nw-alb", retailer: "woolworths", suburb: "Albany", cents: 399, at: "2026-08-11T01:00:00.000Z", seen: "2026-08-13T01:00:00.000Z", src: "nw-1" }),
    ]);
  });

  it("query({retailer}) uses the HISTORICAL store revision (GROK-7)", async () => {
    // Only p2's removed-from-listing offer still displays as newworld; every
    // listed s-nw-alb offer renders at the Aug-13 store revision instead.
    assert.deepEqual(await repository.query({ retailer: "newworld" }), [
      expect({ id: "p2", name: "Product p2", store: "s-nw-alb", retailer: "newworld", cents: 550, at: "2026-08-10T01:00:00.000Z", known: true, src: "nw-2" }),
    ]);
    assert.equal((await repository.query({ retailer: "woolworths" })).length, 4);
    assert.equal((await repository.query({ retailer: "paknsave" })).length, 4);
  });

  it("query({from,to}) filters inclusively and pins asOf at `to`", async () => {
    assert.deepEqual(await repository.query({
      from: "2026-08-11T00:00:00.000Z",
      to: "2026-08-13T23:59:59.999Z",
    }), [
      expect({ id: "p1", name: "Milk 2L fresh", store: "s-nw-alb", retailer: "woolworths", suburb: "Albany", cents: 399, at: "2026-08-11T01:00:00.000Z", seen: "2026-08-13T01:00:00.000Z", src: "nw-1" }),
      expect({ id: "p2", name: "Product p2", store: "s-pns-mt", retailer: "paknsave", suburb: "Mt Roskill", cents: 425, at: "2026-08-11T01:30:00.000Z", known: true, src: "pns-2" }),
      expect({ id: "p3", name: "Product p3", store: "s-pns-mt", retailer: "paknsave", suburb: "Mt Roskill", cents: 620, at: "2026-08-13T01:30:00.000Z", seen: "2026-08-13T01:30:00.000Z", src: "pns-3" }),
    ]);
  });

  it("asOf midday Aug-12 renders pre-change names, retailers, and listings", async () => {
    assert.deepEqual(await repository.query({ to: "2026-08-12T12:00:00.000Z" }), [
      expect({ id: "p1", name: "Product p1", store: "s-pns-mt", retailer: "paknsave", suburb: "Mt Roskill", cents: 320, at: "2026-08-09T05:00:00.000Z", known: true, src: "pns-late" }),
      expect({ id: "p1", name: "Product p1", store: "s-nw-alb", retailer: "newworld", cents: 349, promoCents: 299, at: "2026-08-10T01:00:00.000Z", seen: "2026-08-11T01:00:00.000Z", src: "nw-1" }),
      expect({ id: "p2", name: "Product p2", store: "s-nw-alb", retailer: "newworld", cents: 550, at: "2026-08-10T01:00:00.000Z", seen: "2026-08-11T01:00:00.000Z", src: "nw-2" }),
      expect({ id: "p2", name: "Product p2", store: "s-pns-mt", retailer: "paknsave", suburb: "Mt Roskill", cents: 450, at: "2026-08-10T01:30:00.000Z", seen: "2026-08-11T01:30:00.000Z", src: "pns-2" }),
      expect({ id: "p1", name: "Product p1", store: "s-nw-alb", retailer: "newworld", cents: 399, at: "2026-08-11T01:00:00.000Z", seen: "2026-08-11T01:00:00.000Z", src: "nw-1" }),
      expect({ id: "p2", name: "Product p2", store: "s-pns-mt", retailer: "paknsave", suburb: "Mt Roskill", cents: 425, at: "2026-08-11T01:30:00.000Z", seen: "2026-08-11T01:30:00.000Z", src: "pns-2" }),
    ]);
  });

  it("combined productId/storeId/retailer queries intersect", async () => {
    assert.deepEqual(await repository.query({ productId: "p2", storeId: "s-nw-alb" }), [
      expect({ id: "p2", name: "Product p2", store: "s-nw-alb", retailer: "newworld", cents: 550, at: "2026-08-10T01:00:00.000Z", known: true, src: "nw-2" }),
    ]);
    assert.deepEqual(await repository.query({ productId: "p1", retailer: "woolworths" }).then((rows) => rows.length), 2);
  });

  it("productHistory lists revisions chronologically with pinned hashes", async () => {
    assert.deepEqual(await repository.productHistory("p1"), [
      {
        hash: "bd0cfeec4d1da705985565d87b03ff6424310e4190c2c144cbf2def7b5ad9102",
        observedAt: "2026-08-09T05:00:00.000Z",
        product: { id: "p1", name: "Product p1" },
      },
      {
        hash: "bd0cfeec4d1da705985565d87b03ff6424310e4190c2c144cbf2def7b5ad9102",
        observedAt: "2026-08-10T01:00:00.000Z",
        product: { id: "p1", name: "Product p1" },
      },
      {
        hash: "8dd782f31d79db02651ebf74e9e2bc19a09e1e9d17a4bc630675974525db2932",
        observedAt: "2026-08-13T01:00:00.000Z",
        product: { id: "p1", name: "Milk 2L fresh" },
      },
    ]);
    const p2 = await repository.productHistory("p2");
    assert.equal(p2.length, 1);
    assert.equal(p2[0].observedAt, "2026-08-10T01:00:00.000Z");
    assert.match(p2[0].hash, /^[0-9a-f]{64}$/);
    assert.deepEqual(await repository.productHistory("missing"), []);
  });

  it("the archive survives a round-trip: reload produces identical queries", async () => {
    const reopened = new JsonlObservationRepository(join(directory, "archive.jsonl"));
    const [live, reloaded] = await Promise.all([
      repository.query(),
      reopened.query(),
    ]);
    assert.deepEqual(reloaded, live);
    assert.deepEqual(await reopened.stats(), await repository.stats());
  });

  it("stats() reports counts by type, retailers of latest store revisions, span", async () => {
    assert.deepEqual(await repository.stats(), {
      records: {
        product: 7, // p1 temporal anchor + p1 rename, p2, p3, p4, p5
        store: 5, // s-pns-mt temporal anchor + s-nw-alb×2 + s-wgtn
        offer: 9,
        snapshot: 8, // day-2 writes unchanged-content snapshots too (offersHash differs)
      },
      retailers: ["paknsave", "woolworths"], // latest s-nw-alb revision is woolworths
      firstObservedAt: "2026-08-09T05:00:00.000Z", // the out-of-order append
      lastObservedAt: "2026-08-15T01:30:00.000Z",
    });
  });
});

describe("ArchiveIndex unit behavior", () => {
  function productRecord(id, name, observedAt) {
    return {
      version: 2,
      type: "product",
      productId: id,
      hash: `hash-${id}-${name}`,
      observedAt,
      data: { id, name },
    };
  }

  function offerRecord(offerIdValue, productId, storeId, observedAt, cents) {
    return {
      version: 2,
      type: "offer",
      offerId: offerIdValue,
      productId,
      storeId,
      hash: `hash-${offerIdValue}-${cents}`,
      observedAt,
      data: {
        price: { regularCents: cents },
        source: { retailerProductId: `${productId}-src` },
      },
    };
  }

  function snapshotRecord(scope, storeId, observedAt, added, removed) {
    return {
      version: 2,
      type: "snapshot",
      scope,
      storeId,
      observedAt,
      offerCount: added.length,
      offersHash: `snap-${scope}-${storeId}-${observedAt}`,
      added,
      removed,
    };
  }

  it("planAppend is pure: drafts never leak into live state until applied", () => {
    const index = new ArchiveIndex();
    const observation = obs({ productId: "px", storeId: "sx", retailer: "r", sourceId: "src-x", observedAt: "2026-08-10T00:00:00.000Z", regularCents: 100 });

    const firstPlan = index.planAppend([observation]);
    assert.equal(firstPlan.length, 3); // product + store + offer
    assert.equal(index.getRecords().length, 0); // live state untouched
    assert.equal((index.planAppend([observation])).length, 3); // repeatable

    index.applyAdditions(firstPlan);
    assert.equal(index.getRecords().length, 3);
    // Re-planning the same observation now yields nothing (deduped).
    assert.deepEqual(index.planAppend([observation]), []);
  });

  it("deduplicates revisions at their effective time and preserves reverts", () => {
    const index = new ArchiveIndex();
    const first = obs({ productId: "p1", storeId: "s1", retailer: "r", sourceId: "p1", observedAt: "2026-08-10T00:00:00.000Z", regularCents: 100 });
    const newer = obs({ productId: "p1", storeId: "s1", retailer: "r", sourceId: "p1", observedAt: "2026-08-12T00:00:00.000Z", regularCents: 200 });
    index.applyAdditions(index.planAppend([first]));
    index.applyAdditions(index.planAppend([newer]));
    const revert = obs({ productId: "p1", storeId: "s1", retailer: "r", sourceId: "p1", observedAt: "2026-08-14T00:00:00.000Z", regularCents: 100 });
    assert.equal(index.planAppend([revert]).filter((record) => record.type === "offer").length, 1);
    index.applyAdditions(index.planAppend([revert]));
    assert.deepEqual(index.planAppend([revert]), []);
  });

  it("ORDERING INVARIANT [SOL-7/GROK-7]: revision-at follows chronology with stable ties", () => {
    const index = new ArchiveIndex();
    index.apply(productRecord("p1", "P1", "2026-08-09T00:00:00.000Z"));
    index.apply({ version: 2, type: "store", storeId: "s1", hash: "h-a", observedAt: "2026-08-10T00:00:00.000Z", data: { id: "s1", retailer: "first" } });
    index.apply({ version: 2, type: "store", storeId: "s1", hash: "h-b", observedAt: "2026-08-12T00:00:00.000Z", data: { id: "s1", retailer: "second" } });
    index.apply(offerRecord("p1\u0000s1", "p1", "s1", "2026-08-13T00:00:00.000Z", 100));

    // In-order case: latest revision at-or-before display wins.
    return index.query().then(async (rows) => {
      assert.equal(rows[0].store.retailer, "second");

      // An older revision arriving later must not override the newer
      // chronologically applicable revision.
      index.apply({ version: 2, type: "store", storeId: "s1", hash: "h-c", observedAt: "2026-08-09T00:00:00.000Z", data: { id: "s1", retailer: "earliest-but-last" } });
      const after = await index.query();
      assert.equal(after[0].store.retailer, "second");

      // Equal timestamps tie-break by insertion sequence: the later-applied
      // of two same-ms revisions wins.
      index.apply({ version: 2, type: "store", storeId: "s2", hash: "h-x", observedAt: "2026-08-10T00:00:00.000Z", data: { id: "s2", retailer: "x-first" } });
      index.apply({ version: 2, type: "store", storeId: "s2", hash: "h-y", observedAt: "2026-08-10T00:00:00.000Z", data: { id: "s2", retailer: "y-second" } });
      index.apply(offerRecord("p1\u0000s2", "p1", "s2", "2026-08-13T00:00:00.000Z", 200));
      const tied = await index.query({ storeId: "s2" });
      assert.equal(tied[0].store.retailer, "y-second");
    });
  });

  it("rejects late snapshot planning instead of corrupting later deltas", () => {
    const index = new ArchiveIndex();
    const make = (productId, observedAt) => obs({
      productId,
      storeId: "s1",
      retailer: "r",
      sourceId: productId,
      observedAt,
      regularCents: 100,
    });

    index.applyAdditions(index.planAppend([make("p1", "2026-08-09T00:00:00.000Z")], { snapshotScope: "specials" }));
    index.applyAdditions(index.planAppend([make("p2", "2026-08-12T00:00:00.000Z")], { snapshotScope: "specials" }));
    const before = index.getRecords().length;
    assert.throws(
      () => index.planAppend([make("p3", "2026-08-10T00:00:00.000Z")], { snapshotScope: "specials" }),
      /append snapshots chronologically/,
    );
    assert.equal(index.getRecords().length, before);

    const mixed = new ArchiveIndex();
    const planned = mixed.planAppend([
      make("p4", "2026-08-10T00:00:00.000Z"),
      make("p5", "2026-08-11T00:00:00.000Z"),
    ], { snapshotScope: "specials" });
    assert.equal(planned.find((record) => record.type === "snapshot").observedAt, "2026-08-11T00:00:00.000Z");
  });

  it("listingState reconstruction handles add/remove cycles across days", async () => {
    const index = new ArchiveIndex();
    index.apply(productRecord("p1", "P1", "2026-08-09T00:00:00.000Z"));
    index.apply(productRecord("p2", "P2", "2026-08-09T00:00:00.000Z"));
    index.apply({ version: 2, type: "store", storeId: "s1", hash: "h-s1", observedAt: "2026-08-01T00:00:00.000Z", data: { id: "s1", retailer: "r" } });
    index.apply(offerRecord("o1", "p1", "s1", "2026-08-10T00:00:00.000Z", 100));
    index.apply(offerRecord("o2", "p2", "s1", "2026-08-10T00:00:00.000Z", 200));
    index.apply(snapshotRecord("specials", "s1", "2026-08-10T00:00:00.000Z", ["o1"], []));
    index.apply(snapshotRecord("specials", "s1", "2026-08-11T00:00:00.000Z", ["o2"], []));
    index.apply(snapshotRecord("specials", "s1", "2026-08-12T00:00:00.000Z", [], ["o1"]));

    const at = await index.query({ to: "2026-08-12T12:00:00.000Z" });
    const byOffer = new Map(at.map((row) => [row.source.retailerProductId, row]));
    // o1 removed on Aug-12: no listing fields beyond isOnSpecial: false.
    assert.deepEqual(byOffer.get("p1-src").isOnSpecial, false);
    assert.equal(byOffer.get("p1-src").lastSeenAt, undefined);
    // o2 still active; lastSeenAt is the latest snapshot REPLAYED for the
    // listing (the Aug-12 removal), not the last one touching this offer —
    // pinned exactly as the pre-extraction implementation behaved.
    assert.deepEqual(byOffer.get("p2-src").isOnSpecial, true);
    assert.equal(byOffer.get("p2-src").lastSeenAt, "2026-08-12T00:00:00.000Z");

    // Before o2's add snapshot, o1 is listed while o2 (whose offer record
    // already exists) reads as unlisted.
    const early = await index.query({ to: "2026-08-10T12:00:00.000Z" });
    assert.equal(early.length, 2);
    assert.equal(early[0].lastSeenAt, "2026-08-10T00:00:00.000Z");
    assert.deepEqual(early[0].isOnSpecial, true);
    assert.deepEqual(early[1].isOnSpecial, false);
  });

  it("replays out-of-order snapshots chronologically", async () => {
    const index = new ArchiveIndex();
    index.apply(productRecord("p1", "P1", "2026-08-09T00:00:00.000Z"));
    index.apply({ version: 2, type: "store", storeId: "s1", hash: "h-s1", observedAt: "2026-08-01T00:00:00.000Z", data: { id: "s1", retailer: "r" } });
    index.apply(offerRecord("o1", "p1", "s1", "2026-08-09T00:00:00.000Z", 100));
    index.apply(snapshotRecord("specials", "s1", "2026-08-12T00:00:00.000Z", [], ["o1"]));
    index.apply(snapshotRecord("specials", "s1", "2026-08-10T00:00:00.000Z", ["o1"], []));

    const [row] = await index.query({ to: "2026-08-13T00:00:00.000Z" });
    assert.equal(row.isOnSpecial, false);
  });

  it("rejects malformed records and protects applied records from mutation", () => {
    const index = new ArchiveIndex();
    assert.throws(
      () => index.apply({ version: 2, type: "unknown", observedAt: "2026-08-10T00:00:00.000Z" }),
      /record type must be one of/,
    );
    assert.throws(
      () => index.apply(productRecord("bad", "Bad", "not-a-date")),
      /observedAt must be a valid ISO timestamp/,
    );

    const record = productRecord("p1", "Original", "2026-08-10T00:00:00.000Z");
    index.apply(record);
    record.data.name = "Mutated";
    const records = index.getRecords();
    records[0].data.name = "Returned mutation";
    records.pop();
    assert.equal(index.getRecords().length, 1);
    assert.equal(index.getRecords()[0].data.name, "Original");

    assert.throws(
      () => index.applyAdditions([
        productRecord("p2", "P2", "2026-08-10T00:00:00.000Z"),
        { version: 2, type: "offer", offerId: "bad", productId: "p2", storeId: "s2", observedAt: "2026-08-10T00:00:00.000Z", data: {} },
      ]),
      /offer data must contain price and source/,
    );
    assert.equal(index.getRecords().length, 1);
  });

  it("combined candidate queries intersect product and store indexes", async () => {
    const index = new ArchiveIndex();
    index.apply(productRecord("p1", "P1", "2026-08-09T00:00:00.000Z"));
    index.apply({ version: 2, type: "store", storeId: "s1", hash: "h-s1", observedAt: "2026-08-09T00:00:00.000Z", data: { id: "s1", retailer: "r" } });
    index.apply(offerRecord("non-canonical", "p1", "s1", "2026-08-10T00:00:00.000Z", 100));
    assert.equal((await index.query({ productId: "p1", storeId: "s1" })).length, 1);
  });

  it("stats() starts empty and clears() resets everything", async () => {
    const index = new ArchiveIndex();
    assert.deepEqual(index.stats(), {
      records: { product: 0, store: 0, offer: 0, snapshot: 0 },
      retailers: [],
      firstObservedAt: null,
      lastObservedAt: null,
    });
    index.apply(productRecord("p1", "A", "2026-08-10T00:00:00.000Z"));
    index.clear();
    assert.equal(index.getRecords().length, 0);
    assert.deepEqual(await index.query(), []);
    assert.deepEqual(await index.productHistory("p1"), []);
  });
});

describe("performance smoke", () => {
  it("plans ~20k offers in batches and answers a point query in <50ms", async () => {
    const index = new ArchiveIndex();
    const stores = Array.from({ length: 10 }, (_, i) => `store-${i}`);
    const products = Array.from({ length: 2000 }, (_, i) => `prod-${i}`);
    const batchSize = 500;
    let applied = 0;

    const observations = [];
    for (const [p, productId] of products.entries()) {
      for (const [s, storeId] of stores.entries()) {
        observations.push(obs({
          productId,
          productName: `Item ${p}`,
          storeId,
          retailer: "smoketest",
          sourceId: `${productId}-${storeId}`,
          observedAt: "2026-08-20T00:00:00.000Z",
          regularCents: 100 + ((p * 10 + s) % 900),
        }));
      }
    }
    assert.equal(observations.length, 20000);

    for (let offset = 0; offset < observations.length; offset += batchSize) {
      const additions = index.planAppend(observations.slice(offset, offset + batchSize));
      index.applyAdditions(additions);
      applied += additions.length;
    }
    // 2000 product records + 10 store records + 20k offers.
    assert.equal(applied, 22010);

    const start = performance.now();
    const rows = await index.query({ productId: "prod-1500" });
    const elapsedMs = performance.now() - start;

    assert.equal(rows.length, 10);
    assert.ok(elapsedMs < 50, `point query took ${elapsedMs.toFixed(1)}ms (gate: <50ms)`);
  });
});
