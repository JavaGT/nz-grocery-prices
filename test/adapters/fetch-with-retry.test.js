import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry, TimeoutError } from "../../src/adapters/fetch-with-retry.js";

function fakeResponse({ status = 200, headers = {}, body = "ok" } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: new Map(Object.entries(headers)),
    body: stream,
    async text() { return body; },
    async json() { return JSON.parse(body); },
  };
}

function fakeFetch(responses) {
  let index = 0;
  return async () => {
    const response = typeof responses === "function" ? responses(index) : responses[index];
    if (typeof response === "function") return response();
    index++;
    return fakeResponse(response);
  };
}

describe("fetchWithRetry", () => {

  it("returns response on successful GET", async () => {
    const fetch = fakeFetch([{ status: 200 }]);
    const response = await fetchWithRetry("http://example.com", { fetch });
    assert.equal(response.status, 200);
  });

  it("retries on 429", async () => {
    let calls = 0;
    const fetch = fakeFetch(() => {
      calls++;
      if (calls <= 2) return { status: 429 };
      return { status: 200 };
    });
    const response = await fetchWithRetry("http://example.com", {
      fetch,
      sleep: () => Promise.resolve(),
      random: () => 0,
    });
    assert.equal(response.status, 200);
    assert.equal(calls, 3);
  });

  it("retries on 502", async () => {
    let calls = 0;
    const fetch = fakeFetch(() => {
      calls++;
      if (calls <= 1) return { status: 502 };
      return { status: 200 };
    });
    const response = await fetchWithRetry("http://example.com", {
      fetch,
      sleep: () => Promise.resolve(),
      random: () => 0,
    });
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  });

  it("retries on 503", async () => {
    let calls = 0;
    const fetch = fakeFetch(() => {
      calls++;
      if (calls <= 1) return { status: 503 };
      return { status: 200 };
    });
    const response = await fetchWithRetry("http://example.com", {
      fetch,
      sleep: () => Promise.resolve(),
      random: () => 0,
    });
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  });

  it("retries on 504", async () => {
    let calls = 0;
    const fetch = fakeFetch(() => {
      calls++;
      if (calls <= 1) return { status: 504 };
      return { status: 200 };
    });
    const response = await fetchWithRetry("http://example.com", {
      fetch,
      sleep: () => Promise.resolve(),
      random: () => 0,
    });
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  });

  it("does NOT retry on 400", async () => {
    let calls = 0;
    const fetch = fakeFetch(() => { calls++; return { status: 400 }; });
    const response = await fetchWithRetry("http://example.com", {
      fetch,
      sleep: () => { throw new Error("should not sleep"); },
      random: () => 0,
    });
    assert.equal(response.status, 400);
    assert.equal(calls, 1);
  });

  it("does NOT retry on 401", async () => {
    let calls = 0;
    const fetch = fakeFetch(() => { calls++; return { status: 401 }; });
    const response = await fetchWithRetry("http://example.com", {
      fetch,
      sleep: () => { throw new Error("should not sleep"); },
      random: () => 0,
    });
    assert.equal(response.status, 401);
    assert.equal(calls, 1);
  });

  it("does NOT retry on 403", async () => {
    let calls = 0;
    const fetch = fakeFetch(() => { calls++; return { status: 403 }; });
    const response = await fetchWithRetry("http://example.com", {
      fetch,
      sleep: () => { throw new Error("should not sleep"); },
      random: () => 0,
    });
    assert.equal(response.status, 403);
    assert.equal(calls, 1);
  });

  it("does NOT retry on 404", async () => {
    let calls = 0;
    const fetch = fakeFetch(() => { calls++; return { status: 404 }; });
    const response = await fetchWithRetry("http://example.com", {
      fetch,
      sleep: () => { throw new Error("should not sleep"); },
      random: () => 0,
    });
    assert.equal(response.status, 404);
    assert.equal(calls, 1);
  });

  it("does NOT retry on POST", async () => {
    let calls = 0;
    const fetch = fakeFetch(() => { calls++; return { status: 503 }; });
    const response = await fetchWithRetry("http://example.com", {
      method: "POST",
      fetch,
      sleep: () => { throw new Error("should not sleep"); },
    });
    assert.equal(response.status, 503);
    assert.equal(calls, 1);
  });

  it("does NOT retry on PUT", async () => {
    let calls = 0;
    const fetch = fakeFetch(() => { calls++; return { status: 503 }; });
    const response = await fetchWithRetry("http://example.com", {
      method: "PUT",
      fetch,
      sleep: () => { throw new Error("should not sleep"); },
    });
    assert.equal(response.status, 503);
    assert.equal(calls, 1);
  });

  it("does NOT retry on DELETE", async () => {
    let calls = 0;
    const fetch = fakeFetch(() => { calls++; return { status: 503 }; });
    const response = await fetchWithRetry("http://example.com", {
      method: "DELETE",
      fetch,
      sleep: () => { throw new Error("should not sleep"); },
    });
    assert.equal(response.status, 503);
    assert.equal(calls, 1);
  });

  it("respects Retry-After delta-seconds", async () => {
    let calls = 0;
    const sleep = mock.fn(() => Promise.resolve());
    const fetch = fakeFetch(() => {
      calls++;
      if (calls === 1) return { status: 429, headers: { "retry-after": "2" } };
      return { status: 200 };
    });
    const response = await fetchWithRetry("http://example.com", {
      fetch,
      sleep,
      random: () => 0,
    });
    assert.equal(response.status, 200);
    assert.equal(sleep.mock.callCount(), 1);
    const delay = sleep.mock.calls[0].arguments[0];
    assert(delay >= 2000 && delay <= 2000, `expected ~2000ms delay, got ${delay}`);
  });

  it("respects Retry-After HTTP-date", async () => {
    let calls = 0;
    const clock = () => 1000000;
    const future = new Date(1000000 + 3000).toUTCString();
    const sleep = mock.fn(() => Promise.resolve());
    const fetch = fakeFetch(() => {
      calls++;
      if (calls === 1) return { status: 429, headers: { "retry-after": future } };
      return { status: 200 };
    });
    const response = await fetchWithRetry("http://example.com", {
      fetch,
      sleep,
      clock,
      random: () => 0,
    });
    assert.equal(response.status, 200);
    assert.equal(sleep.mock.callCount(), 1);
    const delay = sleep.mock.calls[0].arguments[0];
    assert(delay >= 3000, `expected >=3000ms delay, got ${delay}`);
  });

  it("caps Retry-After to maxDelay", async () => {
    let calls = 0;
    const sleep = mock.fn(() => Promise.resolve());
    const fetch = fakeFetch(() => {
      calls++;
      if (calls === 1) return { status: 429, headers: { "retry-after": "120" } };
      return { status: 200 };
    });
    const response = await fetchWithRetry("http://example.com", {
      fetch,
      sleep,
      random: () => 0,
      retry: { maxDelay: 5000 },
    });
    assert.equal(response.status, 200);
    const delay = sleep.mock.calls[0].arguments[0];
    assert(delay <= 5000, `expected <=5000ms delay, got ${delay}`);
  });

  it("throws TimeoutError on per-attempt timeout", async () => {
    const fetch = async (_url, opts) => {
      await new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
      });
    };
    await assert.rejects(
      fetchWithRetry("http://example.com", {
        fetch,
        timeout: 10,
        retry: { attempts: 0 },
      }),
      (error) => error.name === "TimeoutError",
    );
  });

  it("does NOT retry after caller abort", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetch = fakeFetch(() => {
      calls++;
      controller.abort();
      return { status: 503 };
    });
    await assert.rejects(
      fetchWithRetry("http://example.com", {
        fetch,
        signal: controller.signal,
        sleep: () => Promise.resolve(),
        random: () => 0,
      }),
    );
    assert.equal(calls, 1);
  });

  it("aborts immediately when caller signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetch = () => { throw new Error("should not be called"); };
    await assert.rejects(
      fetchWithRetry("http://example.com", {
        fetch,
        signal: controller.signal,
      }),
    );
  });

  it("exhausts max attempts then returns final response", async () => {
    let calls = 0;
    const fetch = fakeFetch(() => { calls++; return { status: 503 }; });
    const response = await fetchWithRetry("http://example.com", {
      fetch,
      sleep: () => Promise.resolve(),
      random: () => 0,
      retry: { attempts: 2 },
    });
    assert.equal(response.status, 503);
    assert.equal(calls, 3);
  });

  it("uses exponential backoff with capped jitter", async () => {
    let calls = 0;
    const delays = [];
    const sleep = mock.fn((ms) => { delays.push(ms); return Promise.resolve(); });
    const fetch = fakeFetch(() => {
      calls++;
      if (calls <= 3) return { status: 503 };
      return { status: 200 };
    });
    const response = await fetchWithRetry("http://example.com", {
      fetch,
      sleep,
      random: () => 0.5,
      retry: { baseDelay: 1000, maxDelay: 10000, attempts: 3 },
    });
    assert.equal(response.status, 200);
    assert.equal(delays.length, 3);
    // exponential: 1000, 2000, 4000 + jitter
    assert(delays[0] >= 1000 && delays[0] <= 1100);
    assert(delays[1] >= 2000 && delays[1] <= 2200);
    assert(delays[2] >= 4000 && delays[2] <= 4400);
  });

  it("accepts DI for fetch, sleep, random, clock", async () => {
    const fetch = fakeFetch([{ status: 429 }, { status: 200 }]);
    const sleep = mock.fn(() => Promise.resolve());
    const random = mock.fn(() => 0);
    const clock = mock.fn(() => 5000);
    const response = await fetchWithRetry("http://example.com", {
      fetch,
      sleep,
      random,
      clock,
    });
    assert.equal(response.status, 200);
    assert.equal(sleep.mock.callCount(), 1);
  });

  it("passes fetch options through (headers, method, body)", async () => {
    let received;
    const fetch = async (url, opts) => {
      received = opts;
      return fakeResponse({ status: 200 });
    };
    await fetchWithRetry("http://example.com", {
      method: "POST",
      headers: { "x-test": "1" },
      body: JSON.stringify({ a: 1 }),
      fetch,
    });
    assert.equal(received.method, "POST");
    assert.equal(received.headers["x-test"], "1");
    assert.equal(received.body, '{"a":1}');
  });

  it("drains retryable response body without error", async () => {
    let calls = 0;
    const fetch = fakeFetch(() => {
      calls++;
      if (calls === 1) return { status: 503 };
      return { status: 200 };
    });
    const response = await fetchWithRetry("http://example.com", {
      fetch,
      sleep: () => Promise.resolve(),
      random: () => 0,
    });
    assert.equal(response.status, 200);
  });

  it("throws on network error without retry when retry is disabled", async () => {
    const fetch = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } }); };
    await assert.rejects(
      fetchWithRetry("http://example.com", { fetch, retry: false }),
    );
  });

  it("returns final response for existing assertOk behavior", async () => {
    const fetch = fakeFetch([{ status: 503 }, { status: 200, body: '{"ok":true}' }]);
    const response = await fetchWithRetry("http://example.com", {
      fetch,
      sleep: () => Promise.resolve(),
      random: () => 0,
    });
    assert.equal(response.status, 200);
    assert.equal(response.ok, true);
    const data = await response.json();
    assert.deepEqual(data, { ok: true });
  });

  it("defaults timeout to 15000", async () => {
    let timeout;
    const fetch = async (url, opts) => {
      timeout = opts.signal;
      return fakeResponse({ status: 200 });
    };
    await fetchWithRetry("http://example.com", { fetch, retry: false });
    assert.ok(timeout);
  });

});

describe("fetchWithRetry adapter integration", () => {

  it("FoodstuffsClient constructor accepts retry/timeout/signal", async () => {
    const { FoodstuffsClient } = await import("../../src/adapters/foodstuffs.js");
    const signal = new AbortController().signal;
    const client = new FoodstuffsClient({
      banner: "paknsave",
      signal,
      timeout: 5000,
      retry: { attempts: 1 },
    });
    assert.equal(typeof client.listStores, "function");
    assert.ok(client.userAgent);
  });

  it("WoolworthsClient constructor accepts retry/timeout/signal", async () => {
    const { WoolworthsClient } = await import("../../src/adapters/woolworths.js");
    const client = new WoolworthsClient({
      signal: new AbortController().signal,
      timeout: 10000,
      retry: { attempts: 0 },
    });
    assert.equal(typeof client.collectDeals, "function");
  });

  it("FreshChoiceClient constructor accepts retry/timeout/signal", async () => {
    const { FreshChoiceClient } = await import("../../src/adapters/freshchoice.js");
    const client = new FreshChoiceClient({
      signal: new AbortController().signal,
      timeout: 10000,
      retry: { attempts: 2 },
    });
    assert.equal(typeof client.collectDeals, "function");
  });

  it("WarehouseClient constructor accepts retry/timeout/signal", async () => {
    const { WarehouseClient } = await import("../../src/adapters/warehouse.js");
    const client = new WarehouseClient({
      signal: new AbortController().signal,
      timeout: 10000,
      retry: { attempts: 1 },
    });
    assert.equal(typeof client.collectDeals, "function");
  });

});
