import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildReport, summarizeArchive } from "../scripts/breadth-report.js";

const healthRun = {
  stamp: "2026-09-02T15:30:00Z",
  entries: [
    { retailer: "paknsave", healthy: false, summary: { uniqueProducts: 0, pagesFetched: 0, observationsRecorded: 0 } },
    { retailer: "newworld", healthy: false, summary: { uniqueProducts: 0, pagesFetched: 0, observationsRecorded: 0 } },
    { retailer: "freshchoice", healthy: false, summary: { uniqueProducts: 1677, pagesFetched: 261, observationsRecorded: 1070 } },
    { retailer: "warehouse", healthy: true, summary: { uniqueProducts: 0, pagesFetched: 1, requestsMade: 1, observationsRecorded: 0 } },
    { retailer: "woolworths", healthy: true, summary: { uniqueProducts: 16916, pagesFetched: 154, requestsMade: 155, observationsRecorded: 33833 } },
  ],
};

describe("breadth report", () => {
  it("summarizes JSONL records without confusing products and offers", () => {
    const stats = summarizeArchive("fixture.jsonl", [
      JSON.stringify({ version: 2, type: "product", productId: "freshchoice:p1", observedAt: "2026-09-02T00:00:00Z", data: { gtin: "9400" } }),
      JSON.stringify({ version: 2, type: "store", storeId: "freshchoice:avondale", observedAt: "2026-09-02T00:00:00Z" }),
      JSON.stringify({ version: 2, type: "offer", offerId: "freshchoice:p1\\u0000freshchoice:avondale", productId: "freshchoice:p1", storeId: "freshchoice:avondale", observedAt: "2026-09-02T00:00:00Z" }),
      "not json",
    ].join("\n"));

    assert.equal(stats.lines, 4);
    assert.deepEqual(stats.types, { product: 1, store: 1, offer: 1 });
    assert.equal(stats.products.size, 1);
    assert.equal(stats.offers.size, 1);
    assert.equal(stats.stores.size, 1);
    assert.equal(stats.invalidLines, 1);
    assert.equal(stats.gtinProducts.size, 1);
  });

  it("states that a failed pilot is not nationwide store coverage", () => {
    const archiveStats = [
      summarizeArchive("breadth-pilot.jsonl", [
        JSON.stringify({ type: "store", storeId: "paknsave:pns-1", observedAt: "2026-09-02T00:00:00Z" }),
        JSON.stringify({ type: "store", storeId: "newworld:nw-1", observedAt: "2026-09-02T00:00:00Z" }),
      ].join("\n")),
      summarizeArchive("breadth-pilot-fc.jsonl", JSON.stringify({ type: "store", storeId: "freshchoice:fc-1", observedAt: "2026-09-02T00:00:00Z" })),
    ];
    const report = buildReport({ generatedAt: "2026-09-03T00:00:00Z", run: healthRun, archiveStats });

    assert.match(report, /FAIL — this was not a complete successful run/);
    assert.match(report, /3 of approximately 281/);
    assert.match(report, /not an every-store collection/);
    assert.match(report, /three consecutive healthy nights/);
    assert.match(report, /does not call retailer APIs/);
  });
});
