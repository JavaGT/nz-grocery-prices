import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { crawlCgid, createCurlTransport } from "../src/adapters/warehouse-breadth.js";

const STORE = { id: "warehouse:national-online", retailer: "warehouse", name: "The Warehouse Online" };
const OBSERVED_AT = "2026-08-27T12:00:00.000Z";
const ORIGIN = "https://www.thewarehouse.co.nz";

function tileHtml(id, price = 5.99) {
  return `<div class="product-tile" data-gtm-product="{&quot;id&quot;:&quot;${id}&quot;,&quot;name&quot;:&quot;Product ${id}&quot;,&quot;brand&quot;:&quot;Brand&quot;,&quot;price&quot;:${price},&quot;productThenPrice&quot;:null,&quot;productEAN&quot;:&quot;&quot;,&quot;category&quot;:&quot;Grocery&quot;}">
  <a href="/p/product-${id}/${id}" class="embed-responsive item-link"><img class="tile-image" src="https://example.com/img.jpg"></a>
</div>`;
}

function pageHtml(count, startId = 1) {
  const tiles = [];
  for (let i = 0; i < count; i += 1) tiles.push(tileHtml(String(startId + i)));
  return `<html><body>${tiles.join("\n")}</body></html>`;
}

function fakeExecFile(fixtures) {
  const fixtureFn = typeof fixtures === "function" ? fixtures : null;
  return async (cmd, args, opts) => {
    const url = args[args.length - 1];
    let result;
    if (fixtureFn) {
      result = fixtureFn(url);
    } else {
      result = { status: 200, body: pageHtml(0) };
    }
    return { stdout: result.body + "\n" + String(result.status) };
  };
}

describe("crawlCgid minimal", () => {

  it("steps offsets by 32 and terminates on 0-tile page", async () => {
    const offsets = [];
    const ef = fakeExecFile((url) => {
      const parsed = new URL(url);
      const start = Number(parsed.searchParams.get("start"));
      offsets.push(start);
      if (start === 0) return { status: 200, body: pageHtml(32, 1) };
      if (start === 32) return { status: 200, body: pageHtml(32, 33) };
      return { status: 200, body: pageHtml(0) };
    });
    const transport = createCurlTransport({ execFile: ef, curlPath: "curl", userAgent: "test" });

    const result = await crawlCgid({
      transport,
      cgid: "food",
      origin: ORIGIN,
      store: STORE,
      observedAt: OBSERVED_AT,
      delayMs: 0,
      sleep: () => Promise.resolve(),
    });

    assert.deepEqual(offsets, [0, 32, 64]);
    assert.equal(result.pagesFetched, 3); // offset 0, 32, 64 (0-tile page counted)
    assert.equal(result.pagesWith0Tiles, 1);
    assert.equal(result.uniqueCount, 64);
    assert.equal(result.observations.length, 64);
    assert.equal(result.budgetExhausted, false);
    assert.equal(result.circuitOpen, false);
  });

  it("aborts immediately on 403 (Cloudflare fatal)", async () => {
    const ef = fakeExecFile(() => ({ status: 403, body: "Attention Required! Cloudflare" }));
    const transport = createCurlTransport({ execFile: ef, curlPath: "curl", userAgent: "test" });

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, sleep: () => Promise.resolve(),
    });

    assert.equal(result.circuitOpen, true);
    assert.ok(result.circuitReason.includes("Cloudflare 403"));
    assert.equal(result.requestsMade, 1);
  });

  it("stops when budget is exhausted", async () => {
    const ef = fakeExecFile((url) => {
      const parsed = new URL(url);
      const start = Number(parsed.searchParams.get("start"));
      if (start < 96) return { status: 200, body: pageHtml(32, start * 10 + 1) };
      return { status: 200, body: pageHtml(0) };
    });
    const transport = createCurlTransport({ execFile: ef, curlPath: "curl", userAgent: "test" });

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, budget: 3, sleep: () => Promise.resolve(),
    });

    assert.equal(result.requestsMade, 3);
    assert.equal(result.pagesFetched, 3);
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.uniqueCount, 96);
  });

});