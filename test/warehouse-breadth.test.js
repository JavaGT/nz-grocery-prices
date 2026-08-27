import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  crawlCgid,
  createCurlTransport,
} from "../src/adapters/warehouse-breadth.js";
import {
  assertNotLiveArchive,
  parseArgs,
} from "../scripts/warehouse-breadth.js";

// ---- fixture helpers -------------------------------------------------------

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
      delayMs: 0, sleep: () => Promise.resolve(),
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
      delayMs: 0, sleep: () => Promise.resolve(),
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
      delayMs: 0, sleep: () => Promise.resolve(),
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
      delayMs: 0, sleep: () => Promise.resolve(),
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
      delayMs: 0, sleep: () => Promise.resolve(),
    });

    assert.equal(result.circuitOpen, true);
    assert.ok(result.circuitReason.includes("5 consecutive transport failures"));
    assert.equal(result.consecutiveFailures, 5);
  });

  it("stops when budget is exhausted", async () => {
    const transport = fakeTransport((url) => {
      const start = Number(new URL(url).searchParams.get("start"));
      if (start < 96) return { status: 200, body: pageHtml(32, start * 10 + 1) };
      return { status: 200, body: pageHtml(0) };
    });

    const result = await crawlCgid({
      transport, cgid: "food", origin: ORIGIN,
      store: STORE, observedAt: OBSERVED_AT,
      delayMs: 0, budget: 3, sleep: () => Promise.resolve(),
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
      delayMs: 0, sleep: () => Promise.resolve(),
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
      delayMs: 0, completed, sleep: () => Promise.resolve(),
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
      delayMs: 0, sleep: () => Promise.resolve(),
    });

    assert.equal(result.pagesFetched, 2); // offset 0 page + offset 32 0-tile page
    assert.equal(result.uniqueCount, 32);
    assert.equal(result.circuitOpen, false);
    // 4 transport calls: 2 failures + 1 success for offset 0, then 1 for offset 32 (0-tile).
    // requestsMade counts only successful/failed responses, not thrown transport errors.
    assert.equal(result.requestsMade, 2); // offset 0 success + offset 32 0-tile
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
    assert.equal(opts.forceLive, false);
    assert.equal(opts.help, false);
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