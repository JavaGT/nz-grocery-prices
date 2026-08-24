import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OUTCOME_CATEGORIES,
  createCrawler,
  loadManifest,
  saveManifest,
} from "../scripts/lib/crawler.js";

const {
  SUCCESS,
  ALREADY_DONE,
  FATAL_HTTP,
  RETRY_EXHAUSTED,
  NETWORK_FATAL,
  BUDGET_SKIPPED,
} = OUTCOME_CATEGORIES;

function fakeClock() {
  let now = 0;
  const fn = () => now;
  fn.advance = (ms) => {
    now += ms;
  };
  return fn;
}

/** Deterministic sleep: fast-forwards the paired clock instead of waiting. */
function fakeSleep(clock) {
  return async (ms) => clock.advance(ms);
}

/** Fake fetch returning canned responses; records every call. */
function makeFetch(script, clock) {
  const calls = [];
  const at = clock ?? (() => 0);
  const impl = async (url, init) => {
    calls.push({ url: String(url), init: init ?? null, at: at() });
    const responder = typeof script === "function"
      ? script
      : script[url] ?? (() => ({ status: 200 }));
    return responder(calls.length, url, init);
  };
  impl.calls = calls;
  return impl;
}

function response(status, headers = {}) {
  return {
    status,
    body: null,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
  };
}

test("same-host requests are paced by minHostDelayMs", async () => {
  const clock = fakeClock();
  const fetch = makeFetch(() => response(200), clock);
  const crawler = createCrawler({
    fetch,
    minHostDelayMs: 500,
    clock,
    sleep: fakeSleep(clock),
  });

  await crawler.run([
    { id: "a", url: "https://shop.example/api?page=1" },
    { id: "b", url: "https://shop.example/api?page=2" },
    { id: "c", url: "https://shop.example/api?page=3" },
  ]);

  assert.equal(fetch.calls.length, 3);
  // Gap measured completion → next dispatch must be >= the floor.
  assert.ok(fetch.calls[1].at - fetch.calls[0].at >= 500);
  assert.ok(fetch.calls[2].at - fetch.calls[1].at >= 500);
});

test("different hosts proceed concurrently without blocking each other", async () => {
  const clock = fakeClock();
  const calls = [];
  const fetch = async (url) => {
    calls.push({ url: String(url), at: clock() });
    return response(200);
  };
  const crawler = createCrawler({
    fetch,
    minHostDelayMs: 1000,
    concurrency: 2,
    clock,
    sleep: fakeSleep(clock),
  });

  const { summary } = await crawler.run([
    { id: "one-a", url: "https://one.example/a" },
    { id: "two-a", url: "https://two.example/a" },
    { id: "one-b", url: "https://one.example/b" },
    { id: "two-b", url: "https://two.example/b" },
  ]);

  assert.equal(summary.requestsMade, 4);
  assert.equal(calls.length, 4);
  // The two hosts' first requests both happen before any pacing wait
  // (t=0): neither host waited for the other.
  const firstPerHost = {};
  for (const c of calls) {
    const host = new URL(c.url).host;
    if (!(host in firstPerHost)) firstPerHost[host] = c.at;
  }
  assert.deepEqual(firstPerHost, { "one.example": 0, "two.example": 0 });
});

test("retry with exponential backoff succeeds after transient 500s", async () => {
  const clock = fakeClock();
  let attempt = 0;
  const statuses = [];
  const fetch = makeFetch(() => {
    attempt += 1;
    statuses.push(attempt <= 2 ? 500 : 200);
    return response(statuses.at(-1));
  });
  const delays = [];
  const crawler = createCrawler({
    fetch,
    minHostDelayMs: 0,
    maxRetries: 3,
    baseBackoffMs: 100,
    maxBackoffMs: 10000,
    random: () => 0,
    clock,
    sleep: async (ms) => {
      delays.push(ms);
      clock.advance(ms);
    },
  });

  const { results } = await crawler.run([{ id: "t", url: "https://x.example/p" }]);

  assert.equal(fetch.calls.length, 3);
  assert.deepEqual(delays.slice(0, 2), [100, 200]);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].attempts, 3);
});

test("Retry-After header overrides backoff and is honored", async () => {
  const clock = fakeClock();
  let call = 0;
  const fetch = makeFetch(() => {
    call += 1;
    return call === 1
      ? response(429, { "retry-after": "7" })
      : response(200);
  });
  const sleeps = [];
  const crawler = createCrawler({
    fetch,
    minHostDelayMs: 0,
    maxRetries: 2,
    baseBackoffMs: 100,
    clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
    },
  });

  const { results } = await crawler.run([{ id: "t", url: "https://x.example/p" }]);

  assert.deepEqual(sleeps, [7000]);
  assert.equal(results[0].ok, true);
  assert.equal(results[0].status, 200);
});

test("hard budget halts cleanly mid-run and skips remaining tasks", async () => {
  const clock = fakeClock();
  const fetch = makeFetch(() => response(200));
  const budgetEvents = [];
  const crawler = createCrawler({
    fetch,
    minHostDelayMs: 0,
    budget: 2,
    clock,
    sleep: fakeSleep(clock),
  });
  crawler.events.on("budget", (e) => budgetEvents.push(e));

  const { results, summary } = await crawler.run(
    Array.from({ length: 6 }, (_, i) => ({
      id: `t${i}`,
      url: `https://h.example/${i}`,
    })),
  );

  assert.equal(summary.requestsMade, 2);
  assert.equal(summary.skippedBudget, 4);
  assert.equal(budgetEvents.length, 1);
  assert.deepEqual(
    results.map((r) => r.category),
    [SUCCESS, SUCCESS, BUDGET_SKIPPED, BUDGET_SKIPPED, BUDGET_SKIPPED, BUDGET_SKIPPED],
  );
  // Budget exhaustion does not reject or throw — run resolves cleanly.
  assert.equal(summary.failed, 0);
});

test("manifest round-trips through disk", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crawler-manifest-"));
  try {
    const path = join(dir, "nested", "manifest.json");
    await saveManifest(path, { version: 1, completed: { a: "2026-01-01" } });
    const loaded = await loadManifest(path);
    assert.deepEqual(loaded, { version: 1, completed: { a: "2026-01-01" } });
    const raw = await readFile(path, "utf8");
    assert.match(raw, /"version": 1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadManifest returns null for a missing file", async () => {
  const missing = await loadManifest(join(tmpdir(), "definitely-absent", "m.json"));
  assert.equal(missing, null);
});

test("crashed run resumes where it stopped via manifest", async () => {
  const dir = await mkdtemp(join(tmpdir(), "crawler-resume-"));
  try {
    const manifestPath = join(dir, "crawl-manifest.json");

    // Run 1: crash simulation — budget halts after two successes.
    const first = createCrawler({
      fetch: makeFetch(() => response(200)),
      minHostDelayMs: 0,
      budget: 2,
      clock: fakeClock(),
      sleep: fakeSleep(fakeClock()),
      manifest: { path: manifestPath },
    });
    const tasks = [
      { id: "p1", url: "https://s.example/1" },
      { id: "p2", url: "https://s.example/2" },
      { id: "p3", url: "https://s.example/3" },
    ];
    const run1 = await first.run(tasks);
    assert.equal(run1.summary.succeeded, 2);
    assert.equal(run1.summary.skippedBudget, 1);
    const afterCrash = await loadManifest(manifestPath);
    assert.deepEqual(Object.keys(afterCrash.completed), ["p1", "p2"]);

    // Run 2: fresh crawler instance (simulating process restart), same
    // manifest — p1/p2 are already-done, only p3 hits the network.
    const second = createCrawler({
      fetch: makeFetch(() => response(200)),
      minHostDelayMs: 0,
      clock: fakeClock(),
      sleep: fakeSleep(fakeClock()),
      manifest: { path: manifestPath },
    });
    const resumedEvents = [];
    second.events.on("task-end", (e) => {
      if (e.resumed) resumedEvents.push(e.taskId);
    });
    const run2 = await second.run(tasks);

    assert.deepEqual(resumedEvents, ["p1", "p2"]);
    assert.equal(run2.summary.resumed, 2);
    assert.equal(run2.summary.succeeded, 1);
    assert.equal(run2.summary.requestsMade, 1);
    assert.deepEqual(
      run2.results.map((r) => r.category),
      [ALREADY_DONE, ALREADY_DONE, SUCCESS],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("error taxonomy separates fatal HTTP, retry-exhausted, network-fatal", async () => {
  const clock = fakeClock();
  const plan = {
    "https://e.example/fatal": () => response(404),
    "https://e.example/exhausted": () => response(503),
    "https://e.example/net": () => {
      const err = new Error("socket gone");
      err.cause = { code: "ECONNRESET" };
      throw err;
    },
    "https://e.example/dns": () => {
      const err = new Error("no dns");
      err.cause = { code: "ENOTFOUND" };
      throw err;
    },
  };

  const crawler = createCrawler({
    fetch: makeFetch((n, url) => plan[url]()),
    minHostDelayMs: 0,
    maxRetries: 1,
    baseBackoffMs: 10,
    random: () => 0,
    clock,
    sleep: fakeSleep(clock),
  });

  const { results } = await crawler.run([
    { id: "fatal", url: "https://e.example/fatal" },
    { id: "exhausted", url: "https://e.example/exhausted" },
    { id: "net", url: "https://e.example/net" },
    { id: "dns", url: "https://e.example/dns" },
  ]);

  const byId = Object.fromEntries(results.map((r) => [r.taskId, r]));
  assert.equal(byId.fatal.category, FATAL_HTTP);
  assert.equal(byId.fatal.status, 404);
  assert.equal(byId.exhausted.category, RETRY_EXHAUSTED);
  assert.equal(byId.exhausted.status, 503);
  // Retryable network error burns retries then lands as retry-exhausted.
  assert.equal(byId.net.category, RETRY_EXHAUSTED);
  assert.equal(byId.net.error instanceof Error, true);
  // Non-retryable network error is immediately network-fatal (no retry).
  assert.equal(byId.dns.category, NETWORK_FATAL);
  assert.ok(!("response" in byId.net));
});
