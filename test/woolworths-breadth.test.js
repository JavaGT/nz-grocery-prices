import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseArgs, runCollection } from "../scripts/woolworths-breadth.js";

function product(sku, name = `Product ${sku}`) {
  return {
    sku,
    name,
    brand: "Test Brand",
    price: { originalPrice: 4.99 },
    departments: [],
  };
}

function result(items, totalItems) {
  return {
    context: { fulfilment: { fulfilmentStoreId: "9171", address: "Glenfield" } },
    products: { items, totalItems },
  };
}

describe("woolworths-breadth", () => {
  it("parses pacing and output options", () => {
    assert.deepEqual(parseArgs(["--delay-ms", "2500", "--size", "120"]), {
      file: "data/breadth-pilot-ww.jsonl",
      delayMs: 2500,
      size: 120,
      maxPages: 300,
      budget: 400,
      forceLive: false,
      help: false,
    });
  });

  it("walks departments, dedupes cross-listed products, and records a healthy run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "woolworths-breadth-"));
    const file = join(directory, "archive.jsonl");
    const calls = [];
    const client = {
      async listDepartments() {
        return [{ id: 1, label: "Fruit & Veg" }, { id: 2, label: "Pantry" }];
      },
      async listProducts(options) {
        calls.push(options);
        if (options.dasFilter.startsWith("Department;1")) {
          return result([product("one"), product("shared")], 2);
        }
        return result([product("shared"), product("two")], 2);
      },
    };

    const summary = await runCollection({
      client,
      file,
      delayMs: 0,
      observedAt: "2026-09-02T03:00:00.000Z",
      sleep: async () => {},
      minExpectedProducts: 1,
    });
    const archive = await readFile(file, "utf8");
    assert.equal(summary.healthy, true);
    assert.equal(summary.uniqueProducts, 3);
    assert.equal(summary.pagesFetched, 2);
    assert.equal(summary.observationsRecorded, 7);
    assert.equal(calls[0].sort, "PriceAsc");
    assert.equal((archive.match(/"type":"product"/g) ?? []).length, 3);
    assert.equal((archive.match(/"type":"offer"/g) ?? []).length, 3);
  });

  it("marks a full page at the page cap as incomplete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "woolworths-breadth-"));
    const client = {
      async listDepartments() {
        return [{ id: 1, label: "Fruit & Veg" }];
      },
      async listProducts() {
        return result([product("one")], undefined);
      },
    };
    const summary = await runCollection({
      client,
      file: join(directory, "archive.jsonl"),
      size: 1,
      maxPages: 1,
      budget: 2,
      delayMs: 0,
      sleep: async () => {},
      minExpectedProducts: 1,
    });
    assert.equal(summary.healthy, false);
    assert.equal(summary.incompleteCoverage, true);
  });

  it("marks a run that exhausts its request budget as incomplete", async () => {
    const directory = await mkdtemp(join(tmpdir(), "woolworths-breadth-"));
    const client = {
      async listDepartments() {
        return [{ id: 1, label: "Fruit & Veg" }];
      },
      async listProducts() {
        throw new Error("must not be called after the department request");
      },
    };
    const summary = await runCollection({
      client,
      file: join(directory, "archive.jsonl"),
      budget: 1,
      minExpectedProducts: 1,
    });
    assert.equal(summary.healthy, false);
    assert.equal(summary.budgetExhausted, true);
    assert.equal(summary.incompleteCoverage, true);
  });
});
