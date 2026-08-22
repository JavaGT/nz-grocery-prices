import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlObservationRepository, MemoryObservationRepository } from "../src/repository.js";

function validObservation(overrides = {}) {
  return {
    product: { id: overrides.productId ?? "prod:1", name: "Milk" },
    store: { id: "store:1", retailer: "testretailer" },
    price: { regularCents: 349 },
    source: { retailerProductId: "111" },
    observedAt: "2026-08-23T00:00:00.000Z",
    ...overrides,
  };
}

describe("append-boundary validation (CORE-2)", () => {
  let directory;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "prices-append-boundary-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("MemoryObservationRepository rejects an invalid observation with index and problems", async () => {
    const repository = new MemoryObservationRepository();
    await assert.rejects(
      () =>
        repository.append([
          validObservation({ productId: "prod:ok" }),
          validObservation({ productId: "", observedAt: "not-a-date" }),
        ]),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /index 1/);
        assert.match(error.message, /product\.id must be a non-empty string; observedAt must be an ISO 8601 date string/);
        return true;
      },
    );
  });

  it("JsonlObservationRepository rejects before touching the file", async () => {
    const filePath = join(directory, "archive.jsonl");
    const repository = new JsonlObservationRepository(filePath);
    await assert.rejects(
      () => repository.append([validObservation({ price: { regularCents: -5 } })]),
      (error) => {
        assert.ok(error instanceof TypeError);
        assert.match(error.message, /index 0/);
        assert.match(error.message, /price\.regularCents must be a non-negative integer/);
        return true;
      },
    );
    // Nothing was persisted and memory stays clean.
    const fresh = new JsonlObservationRepository(filePath);
    const observations = await fresh.query();
    assert.equal(observations.length, 0);
  });
});
