import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  crawlCgid,
  createCurlTransport,
} from "../src/adapters/warehouse-breadth.js";
import {
  assertNotLiveArchive,
  parseArgs,
  runCollection,
} from "../scripts/warehouse-breadth.js";

// ---- fixture helpers -------------------------------------------------------

const STORE = { id: "warehouse:national-online", retailer: "warehouse", name: "The Warehouse Online" };
const OBSERVED_AT = "2026-08-27T12:00:00.000Z";
const ORIGIN = "https://www.thewarehouse.co.nz";

function tileHtml(id, price = 5.99, extraFields = "") {
  const jsonFields = `&quot;id&quot;:&quot;${id}&quot;,&quot;name&quot;:&quot;Product ${id}&quot;,&quot;brand&quot;:&quot;Brand&quot;,&quot;price&quot;:${price},&quot;productThenPrice&quot;:null,&quot;productEAN&quot;:&quot;&quot;,&quot;category&quot;:&quot;Grocery&quot;`;
  const suffix = extraFields ? `,${extraFields}` : "";
  return `<div class="product-tile" data-gtm-product="{${jsonFields}${suffix}}">
  <a href="/p/product-${id}/${id}" class="embed-responsive item-link"><img class="tile-image" src="https://example.com/img.jpg"></a>
</div>`;
}

function pageHtml(count, startId = 1) {
  const tiles = [];
  for (let i = 0; i < count; i += 1) tiles.push(tileHtml(String(startId + i)));
  return `<html><body>${tiles.join("\n")}</body></html>`;
}

/** Build a fake execFile-style function from a fixture function (url → {status,body}). */
function fakeExecFile(fn) {
  return async (_cmd, args, _opts) => {
    const url = args[args.length - 1];
    const result = fn(url);
    return { stdout: result.body + "\n" + String(result.status) };
  };
}

/** Shortcut: createCurlTransport wired to a fake execFile. */
function fakeTransport(fn) {
  return createCurlTransport({
    execFile: fakeExecFile(fn),
    curlPath: "curl",
    userAgent: "test-agent",
  });
}

// ---- crawlCgid ------------------------------------------------------------

describe("crawlCgid", () => {

  it("steps offsets by 32 and terminates on 0-tile page", async () => {
    const offsets = [];
    const transport = fakeTransport((url) => {
      const start = Number(new URL(url).searchParams.get("start"));
      offsets.push(start);
      if (start === 0) return { status: 200, body: pageHtml(32, 1) };
      if (start === 32) return { status: 200, body: pageHtml(32, 33) };
      return { status: 200, body: pageHtml(0) };
    });

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 3000, sleep: () => Promise.resolve(),
    });

    assert.deepEqual(offsets, [0, 32, 64]);
    assert.equal(result.pagesFetched, 3);  // offsets 0, 32, 64 (0-tile counted)
    assert.equal(result.pagesWith0Tiles, 1);
    assert.equal(result.uniqueCount, 64);
    assert.equal(result.observations.length, 64);
    assert.equal(result.budgetExhausted, false);
    assert.equal(result.circuitOpen, false);
  });

  it("dedupes product IDs across overlapping windows", async () => {
    // page 0: ids 1–32.  page 1: ids 16–47 → 17 overlap → 15 new → 47 unique.
    const transport = fakeTransport((url) => {
      const start = Number(new URL(url).searchParams.get("start"));
      if (start === 0) return { status: 200, body: pageHtml(32, 1) };
      if (start === 32) return { status: 200, body: pageHtml(32, 16) };
      return { status: 200, body: pageHtml(0) }; // offset 64 → terminate
    });

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 3000, sleep: () => Promise.resolve(),
    });

    assert.equal(result.uniqueCount, 47);
    assert.equal(result.observations.length, 47);
    assert.equal(result.pagesFetched, 3); // offsets 0, 32, 64(0-tile)
  });

  it("aborts immediately on 403 (Cloudflare fatal)", async () => {
    const transport = fakeTransport(() => ({ status: 403, body: "Attention Required!" }));

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, sleep: () => Promise.resolve(), unsafeFastPacing: true,
    });

    assert.equal(result.circuitOpen, true);
    assert.ok(result.circuitReason.includes("Cloudflare 403"));
    assert.equal(result.pagesFetched, 0);
    assert.equal(result.requestsMade, 1);
  });

  it("opens breaker after 5 consecutive HTTP errors (non-403)", async () => {
    const transport = fakeTransport(() => ({ status: 500, body: "server error" }));

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, sleep: () => Promise.resolve(), unsafeFastPacing: true,
    });

    assert.equal(result.circuitOpen, true);
    assert.ok(result.circuitReason.includes("5 consecutive HTTP errors"));
    assert.equal(result.requestsMade, 5);
    assert.equal(result.pagesFetched, 0);
    assert.equal(result.consecutiveFailures, 5);
  });

  it("opens breaker on 5 transport errors", async () => {
    const transport = fakeTransport(() => { throw new Error("curl: Connection reset"); });

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, sleep: () => Promise.resolve(), unsafeFastPacing: true,
    });

    assert.equal(result.circuitOpen, true);
    assert.ok(result.circuitReason.includes("5 consecutive transport failures"));
    assert.equal(result.consecutiveFailures, 5);
  });

  it("stops when budget is exhausted (all attempts counted)", async () => {
    const transport = fakeTransport((url) => {
      const start = Number(new URL(url).searchParams.get("start"));
      if (start < 96) return { status: 200, body: pageHtml(32, start * 10 + 1) };
      return { status: 200, body: pageHtml(0) };
    });

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, budget: 3, sleep: () => Promise.resolve(), unsafeFastPacing: true,
    });

    assert.equal(result.requestsMade, 3);
    assert.equal(result.pagesFetched, 3);
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.uniqueCount, 96);
    assert.equal(result.observations.length, 96);
  });

  it("produces valid observations matching expected shape", async () => {
    let count = 0;
    const transport = fakeTransport((url) => {
      count += 1;
      if (count <= 1) return { status: 200, body: pageHtml(2, 1) };
      return { status: 200, body: pageHtml(0) };
    });

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, sleep: () => Promise.resolve(), unsafeFastPacing: true,
    });

    assert.equal(result.observations.length, 2);
    const obs = result.observations[0];
    assert.ok(obs.product.id.startsWith("warehouse:"));
    assert.ok(typeof obs.product.name === "string");
    assert.ok(obs.price.regularCents > 0);
    assert.equal(obs.store.retailer, "warehouse");
    assert.equal(obs.store.id, "warehouse:national-online");
    assert.equal(obs.observedAt, OBSERVED_AT);
    assert.ok(obs.source.retailerProductId);
    assert.ok(obs.source.url.startsWith("https://"));
  });

  it("skips already-completed offsets from manifest", async () => {
    const offsets = [];
    const transport = fakeTransport((url) => {
      const start = Number(new URL(url).searchParams.get("start"));
      offsets.push(start);
      if (start >= 64) return { status: 200, body: pageHtml(0) };
      return { status: 200, body: pageHtml(32, start * 10 + 1) };
    });

    const completed = new Map([
      ["food:off0", "2026-08-27T12:00:00.000Z"],
      ["food:off32", "2026-08-27T12:00:00.000Z"],
    ]);

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, completed, sleep: () => Promise.resolve(), unsafeFastPacing: true,
    });

    assert.deepEqual(offsets, [64]);
    assert.equal(result.pagesFetched, 1); // 0-tile page counted as fetch
    assert.equal(result.pagesWith0Tiles, 1);
    assert.equal(result.uniqueCount, 0);
  });

  it("recovers from transport errors up to breaker threshold", async () => {
    const calls = [];
    const transport = fakeTransport((url) => {
      const start = Number(new URL(url).searchParams.get("start"));
      calls.push(start);
      // First 2 calls (both for offset 0 → retries) throw.
      if (calls.length <= 2) throw new Error("curl: Connection reset");
      // Third call (still offset 0) succeeds.
      if (start === 0) return { status: 200, body: pageHtml(32) };
      // Any further offset = 0-tile termination.
      return { status: 200, body: pageHtml(0) };
    });

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, sleep: () => Promise.resolve(), unsafeFastPacing: true,
    });

    assert.equal(result.pagesFetched, 2); // offset 0 page + offset 32 0-tile page
    assert.equal(result.uniqueCount, 32);
    assert.equal(result.circuitOpen, false);
    // 4 transport calls: 2 failures + 1 success for offset 0, then 1 for offset 32 (0-tile).
    // requestsMade now counts ALL transport attempts (BLOCKER 2 fix).
    assert.equal(result.requestsMade, 4);
  });

  // ---- BLOCKER 1 — checkpoint resume ----------------------------------------

  it("checkpoints each offset as completed and calls checkpoint callback", async () => {
    const checkpoints = [];
    const completed = new Map();

    const transport = fakeTransport((url) => {
      const start = Number(new URL(url).searchParams.get("start"));
      if (start === 0) return { status: 200, body: pageHtml(32, 1) };
      if (start === 32) return { status: 200, body: pageHtml(32, 33) };
      return { status: 200, body: pageHtml(0) };
    });

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, completed, sleep: () => Promise.resolve(),
      unsafeFastPacing: true,
      checkpoint: (id) => { checkpoints.push(id); },
    });

    // Both data-bearing offsets should be checkpointed.
    assert.ok(checkpoints.includes("food:off0"));
    assert.ok(checkpoints.includes("food:off32"));
    // The 0-tile page (offset 64) is NOT checkpointed — it terminated the walk.
    assert.ok(!checkpoints.includes("food:off64"));
    // completed map should also be populated.
    assert.equal(completed.has("food:off0"), true);
    assert.equal(completed.has("food:off32"), true);
    assert.equal(completed.has("food:off64"), false);
  });

  it("resume skips checkpointed offsets with zero HTTP", async () => {
    // First run: collect 1 page, checkpoint offset 0.
    const completed = new Map();
    const transport1 = fakeTransport((url) => {
      const start = Number(new URL(url).searchParams.get("start"));
      if (start === 0) return { status: 200, body: pageHtml(32, 1) };
      return { status: 200, body: pageHtml(0) };
    });

    await crawlCgid({
      transport: transport1, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, completed, sleep: () => Promise.resolve(),
      unsafeFastPacing: true,
      checkpoint: () => {},
    });

    // Completed should have offset 0.
    assert.equal(completed.has("food:off0"), true);

    // Second run: offset 0 is already in completed, should skip it.
    const offsets = [];
    const transport2 = fakeTransport((url) => {
      const start = Number(new URL(url).searchParams.get("start"));
      offsets.push(start);
      if (start >= 32) return { status: 200, body: pageHtml(0) };
      return { status: 200, body: pageHtml(32, 33) };
    });

    const result2 = await crawlCgid({
      transport: transport2, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, completed, sleep: () => Promise.resolve(),
      unsafeFastPacing: true,
      checkpoint: () => {},
    });

    // Should NOT have fetched offset 0 — skipped via completed Map.
    assert.deepEqual(offsets, [32]);
    assert.equal(result2.pagesFetched, 1);
  });

  // ---- BLOCKER 2 — budget includes curl failures ---------------------------

  it("stops at exactly budget attempts when transport always throws", async () => {
    const transport = fakeTransport(() => { throw new Error("ENOTFOUND"); });

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, budget: 3, sleep: () => Promise.resolve(),
      unsafeFastPacing: true,
    });

    // Exactly 3 attempts made (budget consumed), then stopped.
    assert.equal(result.requestsMade, 3);
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.circuitOpen, false); // breaker is 5, budget hit first
  });

  it("budget counts transport errors and HTTP errors equally", async () => {
    // Alternate: throw, 500, throw, 500...
    let call = 0;
    const transport = fakeTransport(() => {
      call += 1;
      if (call % 2 === 1) throw new Error("ENOTFOUND");
      return { status: 500, body: "error" };
    });

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, budget: 4, sleep: () => Promise.resolve(),
      unsafeFastPacing: true,
    });

    assert.equal(result.requestsMade, 4);
    assert.equal(result.budgetExhausted, true);
  });

  // ---- BLOCKER 3 — fingerprint drift + max ceiling -------------------------

  it("detects repeated window fingerprint and stops as drift", async () => {
    // Every page returns the same 32 product IDs → fingerprint repeats.
    const transport = fakeTransport(() => ({
      status: 200,
      body: pageHtml(32, 1), // always ids 1–32
    }));

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, sleep: () => Promise.resolve(),
      unsafeFastPacing: true,
    });

    assert.equal(result.driftDetected, true);
    assert.equal(result.unhealthyTermination, true);
    assert.ok(result.warnings.some((w) => w.includes("repeated product fingerprint")));
    // Should have processed exactly 1 page (second hit repeated fp and stopped).
    assert.equal(result.pagesFetched, 2); // first fetch (ok), second repeated → stop
  });

  it("stops at maxWindows ceiling", async () => {
    // Return 1 product per page so we can fit many pages in budget.
    function oneTilePage(id) {
      return { status: 200, body: `<html><body>${tileHtml(String(id))}</body></html>` };
    }
    let callIdx = 0;
    const transport = fakeTransport(() => {
      callIdx += 1;
      return oneTilePage(callIdx);
    });

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, sleep: () => Promise.resolve(),
      unsafeFastPacing: true,
      maxWindows: 3,
      budget: 100,
    });

    assert.equal(result.maxWindowsReached, true);
    assert.equal(result.pagesFetched, 3);
  });

  // ---- CONCERN 4 — marketplace exclusion -----------------------------------

  it("excludes marketplace products by default", async () => {
    // Page has 2 regular products and 1 marketplace product.
    const regularTiles = tileHtml("1", 5.99) + "\n" + tileHtml("2", 3.50);
    const marketplaceTile = tileHtml("3", 10.0, '&quot;marketplaceProduct&quot;:true');
    const body = `<html><body>${regularTiles}\n${marketplaceTile}</body></html>`;

    const transport = fakeTransport(() => ({ status: 200, body }));

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, sleep: () => Promise.resolve(), unsafeFastPacing: true,
    });

    assert.equal(result.uniqueCount, 2);
    // Product 3 should be excluded.
    assert.ok(!result.observations.some((o) => o.product.id === "warehouse:3"));
  });

  it("includes marketplace products when includeMarketplace is true", async () => {
    const regularTiles = tileHtml("1", 5.99);
    const marketplaceTile = tileHtml("3", 10.0, '&quot;marketplaceProduct&quot;:true');
    const body = `<html><body>${regularTiles}\n${marketplaceTile}</body></html>`;

    const transport = fakeTransport(() => ({ status: 200, body }));

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, includeMarketplace: true,
      sleep: () => Promise.resolve(), unsafeFastPacing: true,
    });

    assert.equal(result.uniqueCount, 2);
    assert.ok(result.observations.some((o) => o.product.id === "warehouse:3"));
  });

  // ---- CONCERN 5 — pacing floor -------------------------------------------

  it("throws when delayMs < 3000 without unsafeFastPacing", async () => {
    await assert.rejects(
      crawlCgid({
        transport: () => {}, cgid: "food",
        store: STORE, observedAt: OBSERVED_AT,
        delayMs: 500, sleep: () => Promise.resolve(),
      }),
      /pacing floor/,
    );
  });

  it("accepts delayMs < 3000 with unsafeFastPacing", async () => {
    // Just validates it doesn't throw; the actual walk needs a real transport.
    // Products on page 0, then a 0-tile page terminates the walk cleanly.
    const transport = fakeTransport((url) => {
      const start = Number(new URL(url).searchParams.get("start"));
      if (start === 0) return { status: 200, body: pageHtml(1) };
      return { status: 200, body: pageHtml(0) };
    });
    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 500, sleep: () => Promise.resolve(),
      unsafeFastPacing: true,
    });
    assert.equal(result.pagesWith0Tiles, 1);
    assert.equal(result.uniqueCount, 1);
  });

  // ---- CONCERN 6 — zero-parse legitimacy -----------------------------------

  it("retries an empty-grid FIRST page and opens the breaker, not a clean end", async () => {
    // A 0-tile page with valid-looking HTML at the START of a fresh walk is
    // not a credible catalogue end — it is how a block/consent page that
    // parses as HTML presents (the Sep-2026 pilot stall). It must retry and
    // eventually trip the breaker instead of reporting a healthy 0-product
    // crawl.
    const body = '<html><body><div class="product-grid"></div></body></html>';
    const transport = fakeTransport(() => ({ status: 200, body }));

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, sleep: () => Promise.resolve(), unsafeFastPacing: true,
    });

    assert.equal(result.circuitOpen, true);
    assert.ok(result.circuitReason.includes("0-tile"));
    assert.equal(result.pagesWith0Tiles, 0);
    assert.equal(result.uniqueCount, 0);
    assert.equal(result.requestsMade, 5);
    assert.equal(result.unhealthyTermination, true);
  });

  it("recovers when the first page is empty but a retry returns products", async () => {
    const body = '<html><body><div class="product-grid"></div></body></html>';
    let call = 0;
    const transport = fakeTransport((url) => {
      call += 1;
      const start = Number(new URL(url).searchParams.get("start"));
      if (call <= 2) return { status: 200, body }; // two empty first pages
      if (start === 0) return { status: 200, body: pageHtml(32) };
      return { status: 200, body: pageHtml(0) };
    });

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, sleep: () => Promise.resolve(), unsafeFastPacing: true,
    });

    assert.equal(result.circuitOpen, false);
    assert.equal(result.uniqueCount, 32);
    assert.equal(result.pagesWith0Tiles, 1);
    // 2 empty retries + 1 product page + 1 end page.
    assert.equal(result.requestsMade, 4);
  });

  it("still terminates cleanly on a 0-tile page after resume skips", async () => {
    // With completed windows (resume), reaching a 0-tile page with zero
    // products collected is a credible end — the earlier windows were
    // checkpointed by a previous run.
    const completed = new Map([["food:off0", "2026-08-27T12:00:00.000Z"]]);
    const transport = fakeTransport(() => ({ status: 200, body: pageHtml(0) }));

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, completed, sleep: () => Promise.resolve(),
      unsafeFastPacing: true,
    });

    assert.equal(result.circuitOpen, false);
    assert.equal(result.skippedCompleted, 1);
    assert.equal(result.pagesWith0Tiles, 1);
    assert.equal(result.uniqueCount, 0);
  });

  it("treats Cloudflare challenge body as failure (counts toward breaker)", async () => {
    // Cloudflare challenge page (no product tiles).
    const body = '<html><body><h1>Attention Required!</h1><p>cf-browser-verification</p></body></html>';
    const transport = fakeTransport(() => ({ status: 200, body }));

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, sleep: () => Promise.resolve(), unsafeFastPacing: true,
    });

    // Should treat it as a failure — it will retry 5 times, then open the
    // circuit since consecutive non-grid failures accumulate.
    assert.equal(result.circuitOpen, true);
    assert.ok(result.circuitReason.includes("5 consecutive non-grid responses"));
    assert.ok(result.warnings.some((w) => w.includes("non-grid")));
  });

  it("opens breaker after 5 consecutive non-grid responses", async () => {
    const body = '<html><body><h1>Attention Required!</h1></body></html>';
    const transport = fakeTransport(() => ({ status: 200, body }));

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, sleep: () => Promise.resolve(), unsafeFastPacing: true,
    });

    assert.equal(result.circuitOpen, true);
    assert.ok(result.circuitReason.includes("5 consecutive non-grid responses"));
    assert.equal(result.requestsMade, 5);
  });

  // ---- NIT 7 — execFile + hostile strings -----------------------------------

  it("createCurlTransport passes args as an array (no shell:true)", async () => {
    const capturedArgs = [];
    const ef = async (_cmd, args, _opts) => {
      capturedArgs.push(...args);
      return { stdout: "<html>OK</html>\n200" };
    };
    const t = createCurlTransport({ execFile: ef, curlPath: "curl", userAgent: "test" });
    await t("https://example.com/t");

    // Must be passed as array elements, never a concatenated shell string.
    assert.ok(Array.isArray(capturedArgs));
    // The URL should be a single argv element.
    const urlArg = capturedArgs[capturedArgs.length - 1];
    assert.equal(urlArg, "https://example.com/t");
  });

  it("handles hostile cgid strings without shell injection", async () => {
    // Create a transport that captures args and passes through
    const capturedArgs = [];
    const ef = async (_cmd, args, _opts) => {
      capturedArgs.push(...args);
      return { stdout: "<html>OK</html>\n200" };
    };
    const t = createCurlTransport({ execFile: ef, curlPath: "curl", userAgent: "test" });

    await t("https://example.com/updategrid?cgid=foo'bar&start=0");

    // The URL must be a single argv element, not split on injected chars.
    const urlArg = capturedArgs[capturedArgs.length - 1];
    assert.equal(urlArg, "https://example.com/updategrid?cgid=foo'bar&start=0");
    assert.ok(Array.isArray(capturedArgs));
  });

  it("hostile cgid strings produce correct gridUrl via crawlCgid", async () => {
    // Setup: hostile cgid with spaces, quotes, semicolons
    const allArgs = [];
    const ef = async (_cmd, args, _opts) => {
      allArgs.push(...args);
      return { stdout: "page\n200" };
    };
    const transport = createCurlTransport({ execFile: ef, curlPath: "curl", userAgent: "test" });

    await crawlCgid({
      transport,
      cgid: "foo'bar; rm -rf /",
      store: STORE,
      observedAt: OBSERVED_AT,
      delayMs: 0, sleep: () => Promise.resolve(),
      unsafeFastPacing: true,
    });

    // The URL should be one unbroken argv element despite the hostile chars.
    const urlArg = allArgs[allArgs.length - 1];
    // URLSearchParams encodes spaces as +, not %20 — just check for key
    // encoded characters and that the URL isn't split.
    assert.ok(urlArg.includes("cgid=foo%27bar"));
    assert.ok(urlArg.includes("start=0"));
    // No shell-escape chars should break the array.
    assert.equal(allArgs.filter((a) => a.includes("rm -rf")).length, 0);
  });

});

// ---- createCurlTransport --------------------------------------------------

describe("createCurlTransport", () => {

  it("extracts status and body from fake execFile output", async () => {
    const ef = async () => ({ stdout: "<html>OK</html>\n200" });
    const t = createCurlTransport({ execFile: ef, curlPath: "curl", userAgent: "test" });
    const { status, body } = await t("https://example.com/t");
    assert.equal(status, 200);
    assert.equal(body, "<html>OK</html>");
  });

  it("extracts non-200 status", async () => {
    const ef = async () => ({ stdout: "blocked\n403" });
    const t = createCurlTransport({ execFile: ef, curlPath: "curl", userAgent: "test" });
    const { status, body } = await t("https://example.com/t");
    assert.equal(status, 403);
    assert.equal(body, "blocked");
  });

  it("handles empty body with status", async () => {
    const ef = async () => ({ stdout: "\n200" });
    const t = createCurlTransport({ execFile: ef, curlPath: "curl", userAgent: "test" });
    const { status, body } = await t("https://example.com/t");
    assert.equal(status, 200);
    assert.equal(body, "");
  });

});

// ---- parseArgs -------------------------------------------------------------

describe("parseArgs (warehouse-breadth)", () => {

  it("uses defaults for empty args", () => {
    const opts = parseArgs([]);
    assert.equal(opts.cgid, "foodhouseholdpets-fooddrink");
    assert.equal(opts.file, "data/breadth-pilot-tw.jsonl");
    assert.equal(opts.delayMs, 3000);
    assert.equal(opts.budget, 400);
    assert.equal(opts.minExpectedProducts, 500);
    assert.equal(opts.resume, false);
    assert.equal(opts.forceLive, false);
    assert.equal(opts.help, false);
  });

  it("sets --resume and --min-expected-products", () => {
    const opts = parseArgs(["--resume", "--min-expected-products", "42"]);
    assert.equal(opts.resume, true);
    assert.equal(opts.minExpectedProducts, 42);
  });

  it("throws on negative min-expected-products", () => {
    assert.throws(() => parseArgs(["--min-expected-products", "-1"]), TypeError);
  });

  it("parses explicit --cgid, --file, --delay-ms, --budget", () => {
    const opts = parseArgs(["--cgid", "root", "--file", "x.jsonl", "--delay-ms", "5000", "--budget", "100"]);
    assert.equal(opts.cgid, "root");
    assert.equal(opts.file, "x.jsonl");
    assert.equal(opts.delayMs, 5000);
    assert.equal(opts.budget, 100);
  });

  it("throws on negative delay-ms", () => { assert.throws(() => parseArgs(["--delay-ms", "-1"]), TypeError); });
  it("throws on non-integer budget", () => { assert.throws(() => parseArgs(["--budget", "1.5"]), TypeError); });
  it("throws on zero budget", () => { assert.throws(() => parseArgs(["--budget", "0"]), TypeError); });
  it("sets --force-live", () => { assert.equal(parseArgs(["--force-live"]).forceLive, true); });
  it("sets --help", () => { assert.equal(parseArgs(["--help"]).help, true); });
  it("respects -h", () => { assert.equal(parseArgs(["-h"]).help, true); });
  it("throws on unknown argument", () => { assert.throws(() => parseArgs(["--bogus"]), TypeError); });

});

// ---- assertNotLiveArchive -------------------------------------------------

describe("assertNotLiveArchive (warehouse-breadth)", () => {

  it("passes for pilot file", () => { assertNotLiveArchive("data/breadth-pilot-tw.jsonl"); });
  it("throws for live archive", () => { assert.throws(() => assertNotLiveArchive("data/prices.jsonl"), /Refusing/); });
  it("passes with --force-live", () => { assertNotLiveArchive("data/prices.jsonl", { forceLive: true }); });
  it("passes for custom file", () => { assertNotLiveArchive("data/custom.jsonl"); });

});

// ---- runCollection — nightly fresh-by-default ------------------------------

describe("runCollection (warehouse-breadth)", () => {

  /** Fake {status, body} transport; products on offset 0, end page after. */
  function fakeBodyTransport() {
    return async (url) => {
      const start = Number(new URL(url).searchParams.get("start"));
      if (start === 0) return { status: 200, body: pageHtml(2) };
      return { status: 200, body: pageHtml(0) };
    };
  }

  async function withTmp(fn) {
    const dir = await mkdtemp(join(tmpdir(), "warehouse-breadth-run-"));
    try {
      return await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function seedManifest(file, cgid, offsets) {
    await mkdir(join(file, ".."), { recursive: true });
    await writeFile(
      `${file}.breadth-manifest.json`,
      JSON.stringify({
        version: 1,
        updatedAt: "2026-09-01T00:00:00.000Z",
        completed: Object.fromEntries(
          offsets.map((off) => [`${cgid}:off${off}`, "2026-09-01T00:00:00.000Z"]),
        ),
      }),
    );
  }

  it("ignores a stale manifest by default and re-crawls nightly", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "breadth-pilot-tw.jsonl");
      // A previous complete run left every window checkpointed.
      await seedManifest(file, "food", [0, 32, 64]);

      const summary = await runCollection({
        cgid: "food",
        file,
        transport: fakeBodyTransport(),
        minExpectedProducts: 1,
        observedAt: OBSERVED_AT,
        clock: () => Date.parse(OBSERVED_AT),
        sleep: () => Promise.resolve(),
        log: () => {},
        collectWarning: () => {},
      });

      assert.equal(summary.healthy, true);
      assert.equal(summary.uniqueProducts, 2);
      assert.equal(summary.skippedCompleted, 0);
    });
  });

  it("--resume skips recorded windows; the floor flags a no-data run", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "breadth-pilot-tw.jsonl");
      await seedManifest(file, "food", [0]);

      const summary = await runCollection({
        cgid: "food",
        file,
        resume: true,
        transport: fakeBodyTransport(),
        minExpectedProducts: 1,
        observedAt: OBSERVED_AT,
        clock: () => Date.parse(OBSERVED_AT),
        sleep: () => Promise.resolve(),
        log: () => {},
        collectWarning: () => {},
      });

      // Offset 0 skipped, end page reached with nothing collected — the
      // nightly floor must call this unhealthy, not the silent stall.
      assert.equal(summary.skippedCompleted, 1);
      assert.equal(summary.uniqueProducts, 0);
      assert.equal(summary.healthy, false);
    });
  });

});