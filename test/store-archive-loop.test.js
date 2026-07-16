import assert from "node:assert/strict";
import test from "node:test";
import {
  archiveEachStore,
  exitCodeForStoreResults,
  summarizeStoreResults,
} from "../scripts/lib/store-archive-loop.js";

test("archiveEachStore records every store and delays between them", async () => {
  const stores = [
    { id: "a", name: "Store A" },
    { id: "b", name: "Store B" },
    { id: "c", name: "Store C" },
  ];
  const collected = [];
  const recorded = [];
  const sleeps = [];

  const results = await archiveEachStore({
    stores,
    delayMs: 50,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    collectForStore: async (store) => {
      collected.push(store.id);
      return [{ product: { id: store.id }, store }];
    },
    record: async (observations) => {
      recorded.push(observations.length);
      return observations.length;
    },
  });

  assert.deepEqual(collected, ["a", "b", "c"]);
  assert.deepEqual(recorded, [1, 1, 1]);
  assert.deepEqual(sleeps, [50, 50]);
  assert.equal(results.length, 3);
  assert.equal(results.every((r) => r.ok), true);
  assert.equal(results[0].fetched, 1);
  assert.equal(results[0].added, 1);
});

test("archiveEachStore continues after a single-store failure", async () => {
  const stores = [
    { id: "a", name: "Store A" },
    { id: "b", name: "Store B" },
    { id: "c", name: "Store C" },
  ];

  const results = await archiveEachStore({
    stores,
    delayMs: 0,
    collectForStore: async (store) => {
      if (store.id === "b") throw new Error("rate limited");
      return [{ id: store.id }];
    },
    record: async (observations) => observations.length,
  });

  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, false);
  assert.match(results[1].error, /rate limited/);
  assert.equal(results[2].ok, true);

  const summary = summarizeStoreResults(results);
  assert.equal(summary.stores, 3);
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.fetched, 2);
  assert.equal(summary.added, 2);
  assert.equal(exitCodeForStoreResults(summary), 0);
});

test("exitCodeForStoreResults is 1 when every store fails or list is empty", () => {
  assert.equal(exitCodeForStoreResults({ stores: 0, succeeded: 0 }), 1);
  assert.equal(
    exitCodeForStoreResults({ stores: 2, succeeded: 0, failed: 2 }),
    1,
  );
  assert.equal(
    exitCodeForStoreResults({ stores: 2, succeeded: 1, failed: 1 }),
    0,
  );
});

test("archiveEachStore with zero delay does not sleep", async () => {
  let slept = false;
  await archiveEachStore({
    stores: [{ id: "a", name: "A" }, { id: "b", name: "B" }],
    delayMs: 0,
    sleep: async () => {
      slept = true;
    },
    collectForStore: async () => [],
    record: async () => 0,
  });
  assert.equal(slept, false);
});
