import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MobileFoodstuffsClient, toPriceObservation } from "../../src/adapters/foodstuffs-mobile.js";

describe("MobileFoodstuffsClient", () => {
  const store = { id: "store-1", name: "PAK'nSAVE Testville" };

  // ---- constructor validation ----

  it("rejects unsupported banners", () => {
    assert.throws(() => new MobileFoodstuffsClient({ banner: "INVALID" }), TypeError);
    assert.throws(() => new MobileFoodstuffsClient({ banner: "PAKNSAVE" }), TypeError);
  });

  it("defaults banner to PNS and retailer to paknsave", () => {
    const client = new MobileFoodstuffsClient({ fetch: async () => ({ ok: true, json: async () => ({}) }) });
    assert.equal(client.banner, "PNS");
    assert.equal(client.retailer, "paknsave");
  });

  it("accepts MNW banner and returns newworld retailer", () => {
    const client = new MobileFoodstuffsClient({
      banner: "MNW",
      fetch: async () => ({ ok: true, json: async () => ({}) }),
    });
    assert.equal(client.banner, "MNW");
    assert.equal(client.retailer, "newworld");
  });

  it("accepts custom apiOrigin and userAgent", () => {
    const fetch = async () => ({ ok: true, json: async () => ({}) });
    const client = new MobileFoodstuffsClient({
      apiOrigin: "https://custom.example.com/prod",
      userAgent: "CustomApp/1.0",
      fetch,
    });
    assert.ok(client);
  });

  // NIT 9: trailing slashes stripped from apiOrigin
  it("strips trailing slashes from apiOrigin", () => {
    const client = new MobileFoodstuffsClient({
      apiOrigin: "https://custom.example.com/prod///",
      fetch: async () => ({ ok: true, json: async () => ({}) }),
    });
    // No public accessor for apiOrigin, but the constructor strips
    // via .replace(/\/+$/, "") — we verify via a side effect: request URL
    const calls = [];
    const fetch = async (url, init) => {
      calls.push(String(url));
      if (String(url).includes("/mobile/user/login/guest")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      }
      return { ok: true, status: 200, json: async () => [] };
    };
    const client2 = new MobileFoodstuffsClient({ apiOrigin: "https://x.com/prod/", fetch });
    // Trigger an auth call to verify the URL has no double slash
    // force auth by not having a token
    // Actually just verify the constructor doesn't throw and the URL is sane
    // by making a request that goes through the origin
    return client2.listStores().then(() => {
      const authCall = calls.find(c => c.includes("/mobile/user/login/guest"));
      assert.ok(authCall, "auth call should exist");
      // Should be https://x.com/prod/mobile/user/login/guest, not https://x.com/prod//mobile/...
      assert.equal(authCall, "https://x.com/prod/mobile/user/login/guest");
    });
  });

  // ---- authentication caching ----

  it("caches the token and reuses it within expiry margin", async () => {
    let authCalls = 0;
    const fetch = async (url, init) => {
      if (String(url).includes("/mobile/user/login/guest")) {
        authCalls += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "token-1",
            expires_in: 3600, // 1 hour
          }),
        };
      }
      if (String(url).includes("/mobile/store/physical")) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: "s1", name: "Store 1" }],
        };
      }
      throw new Error(`unexpected ${url}`);
    };
    const client = new MobileFoodstuffsClient({ fetch });

    await client.listStores(); // first call authenticates
    await client.listStores(); // second reuses cached token
    assert.equal(authCalls, 1);
  });

  it("re-authenticates after token expiry", async () => {
    let authCalls = 0;
    const fetch = async (url, init) => {
      if (String(url).includes("/mobile/user/login/guest")) {
        authCalls += 1;
        const parsed = JSON.parse(init.body);
        assert.equal(parsed.banner, "PNS");
        assert.equal(init.headers["content-type"], "application/json");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: `token-${authCalls}`,
            expires_in: 1, // 1 second
          }),
        };
      }
      if (String(url).includes("/mobile/store/physical")) {
        return {
          ok: true,
          status: 200,
          json: async () => [{ id: "s1" }],
        };
      }
      throw new Error(`unexpected ${url}`);
    };
    const client = new MobileFoodstuffsClient({ fetch });

    await client.listStores(); // auth call 1
    assert.equal(authCalls, 1);

    // The margin is 60_000ms, and expires_in is 1s (1000ms).
    // So expiresAt = now + 1000, margin is 60000.
    // With Date.now() the second call is within the same millisecond,
    // so now < expiresAt (1000) - 60000 → false → force re-auth.
    await client.listStores();
    assert.equal(authCalls, 2);
  });

  // CONCERN 4a: in-flight auth memoization
  it("shares a single in-flight auth promise across concurrent first calls", async () => {
    let authCalls = 0;
    let resolveAuth;
    let authStarted = false;
    const fetch = async (url, init) => {
      if (String(url).includes("/mobile/user/login/guest")) {
        authCalls += 1;
        authStarted = true;
        // Don't resolve until caller waits
        return new Promise((resolve) => {
          resolveAuth = () => resolve({
            ok: true,
            status: 200,
            json: async () => ({ access_token: "shared-token", expires_in: 3600 }),
          });
        });
      }
      if (String(url).includes("/mobile/store/physical")) {
        return { ok: true, status: 200, json: async () => [{ id: "s1" }] };
      }
      throw new Error(`unexpected ${url}`);
    };
    const client = new MobileFoodstuffsClient({ fetch });

    // Fire two concurrent calls — they should share one auth
    const promise1 = client.listStores();
    const promise2 = client.listStores();

    // Wait a microtask for both to reach the auth gate
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(authCalls, 1, "only one auth should have started");
    assert.ok(authStarted);
    resolveAuth();
    const [r1, r2] = await Promise.all([promise1, promise2]);
    assert.deepEqual(r1, [{ id: "s1" }]);
    assert.deepEqual(r2, [{ id: "s1" }]);
    assert.equal(authCalls, 1, "still only one auth call after both resolve");
  });

  it("throws on auth failure", async () => {
    const fetch = async () => ({ ok: false, status: 401, statusText: "Unauthorized" });
    const client = new MobileFoodstuffsClient({ fetch });
    await assert.rejects(() => client.listStores(), /Mobile guest auth failed/);
  });

  it("throws when auth returns no access_token", async () => {
    const fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ expires_in: 3600 }), // no access_token
    });
    const client = new MobileFoodstuffsClient({ fetch });
    await assert.rejects(() => client.listStores(), /no access token/);
  });

  it("throws a clear error when guest auth returns a null payload", async () => {
    const fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => null,
    });
    const client = new MobileFoodstuffsClient({ fetch });
    await assert.rejects(
      () => client.listStores(),
      /guest auth returned a non-object payload/,
    );
  });

  // CONCERN 4b: expires_in validation
  it("throws TypeError when expires_in is not a positive finite number", async () => {
    for (const badValue of [undefined, null, "3600", -1, 0, Infinity]) {
      const fetch = async (url, init) => {
        if (String(url).includes("/mobile/user/login/guest")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: "t", expires_in: badValue }),
          };
        }
        return { ok: true, status: 200, json: async () => [] };
      };
      const client = new MobileFoodstuffsClient({ fetch });
      await assert.rejects(
        () => client.listStores(),
        TypeError,
        `expected TypeError for expires_in=${JSON.stringify(badValue)}`,
      );
    }
  });

  // ---- request header shape ----

  it("sends Authorization Bearer and User-Agent on authenticated requests", async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/mobile/user/login/guest")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: "test-token", expires_in: 3600 }),
        };
      }
      return { ok: true, status: 200, json: async () => [] };
    };
    const client = new MobileFoodstuffsClient({ fetch });
    await client.listStores();

    // The store list call should have the auth headers
    const storeCall = calls.find((c) => String(c.url).includes("/mobile/store/physical"));
    assert.ok(storeCall, "store list call not found");
    assert.equal(storeCall.init.headers.authorization, "Bearer test-token");
    assert.ok(storeCall.init.headers["user-agent"]);
  });

  // ---- listStores ----

  // ---- error body teardown ----

  it("cancels the error body before the backoff sleep on a retryable 5xx", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("exploded"));
        controller.close();
      },
      cancel() { cancelled = true; },
    });
    let attempts = 0;
    const fetch = async (url) => {
      if (String(url).includes("/mobile/store/physical")) {
        attempts += 1;
        if (attempts === 1) {
          return { ok: false, status: 503, statusText: "Service Unavailable", body: stream };
        }
        return { ok: true, status: 200, json: async () => ({ stores: [{ id: "s1", name: "Store 1" }] }) };
      }
      return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
    };
    const client = new MobileFoodstuffsClient({ fetch, retryBackoffMs: 1 });
    const stores = await client.listStores();
    assert.equal(attempts, 2, "503 must be retried once");
    assert.equal(cancelled, true, "the 5xx body must be cancelled before the backoff sleep");
    assert.deepEqual(stores.map((s) => s.id), ["s1"]);
  });

  it("cancels the error body before throwing on a non-retryable status", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      // Keep a chunk queued so the stream stays readable; cancel() on an
      // already-closed stream never reaches the underlying source.
      start(controller) {
        controller.enqueue(new TextEncoder().encode("gone"));
      },
      cancel() { cancelled = true; },
    });
    const fetch = async (url) => {
      if (String(url).includes("/mobile/store/physical")) {
        return { ok: false, status: 404, statusText: "Not Found", body: stream };
      }
      return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
    };
    const client = new MobileFoodstuffsClient({ fetch, retryBackoffMs: 1 });
    await assert.rejects(() => client.listStores(), /failed: 404 Not Found/);
    assert.equal(cancelled, true, "the error body must be cancelled to release the connection");
  });

  it("retries transient network failures before succeeding", async () => {
    let attempts = 0;
    const fetch = async (url) => {
      if (String(url).includes("/mobile/store/physical")) {
        attempts += 1;
        if (attempts === 1) throw new Error("connect ECONNRESET"); // transient blip
        return {
          ok: true, status: 200,
          json: async () => ({ stores: [{ id: "s1", name: "Store 1" }] }),
        };
      }
      return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
    };
    // retryBackoffMs keeps the real retry semantics (2 retryable attempts,
    // linear backoff) without 3-6s of real sleeps per failing test.
    const client = new MobileFoodstuffsClient({ fetch, retryBackoffMs: 1 });
    const result = await client.listStores();
    assert.equal(attempts, 2, "transient network failure retried once");
    assert.deepEqual(result.map((s) => s.id), ["s1"]);
  });

  it("listStores uses GET with banner query param and normalizes {stores:[…]}", async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push(String(url));
      if (String(url).includes("/mobile/user/login/guest")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      }
      // Live-verified envelope: wrapped in a stores key.
      return { ok: true, status: 200, json: async () => ({ stores: [{ id: "s1", name: "Store 1" }] }) };
    };
    const client = new MobileFoodstuffsClient({ fetch });
    const result = await client.listStores();
    const storeCall = calls.find((c) => c.includes("/mobile/store/physical"));
    assert.ok(storeCall, "store list call not found");
    assert.ok(storeCall.includes("banner=PNS"), storeCall);
    assert.doesNotMatch(storeCall, /method/i);
    assert.deepEqual(result, [{ id: "s1", name: "Store 1" }]);
  });

  it("listStores passes response through for MNW", async () => {
    const fetch = async (url, init) => {
      if (String(url).includes("/mobile/user/login/guest")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      }
      return { ok: true, status: 200, json: async () => [{ id: "nw1", name: "NW Store" }] };
    };
    const client = new MobileFoodstuffsClient({ banner: "MNW", fetch });
    const result = await client.listStores();
    assert.deepEqual(result, [{ id: "nw1", name: "NW Store" }]);
  });

  // CONCERN 8: normalized envelope forms
  it("listStores normalizes bare array, {stores:[...]}, {items:[...]}", async () => {
    for (const responseBody of [
      [{ id: "s1", name: "Store 1" }],
      { stores: [{ id: "s1", name: "Store 1" }] },
      { items: [{ id: "s1", name: "Store 1" }] },
    ]) {
      const fetch = async (url, init) => {
        if (String(url).includes("/mobile/user/login/guest")) {
          return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
        }
        return { ok: true, status: 200, json: async () => responseBody };
      };
      const client = new MobileFoodstuffsClient({ fetch });
      const result = await client.listStores();
      assert.deepEqual(result, [{ id: "s1", name: "Store 1" }]);
    }
  });

  // ---- categoryTree ----

  it("categoryTree builds correct URL with storeId, banner, region", async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/mobile/user/login/guest")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      }
      return { ok: true, status: 200, json: async () => [{ name: "Pantry", children: [] }] };
    };
    const client = new MobileFoodstuffsClient({ fetch });
    await client.categoryTree("store-1");
    const treeCall = calls.find((c) => c.url.includes("/mobile/v1/products/category"));
    assert.ok(treeCall, "category tree call not found");
    assert.ok(treeCall.url.includes("storeId=store-1"));
    assert.ok(treeCall.url.includes("banner=paknsave"));
    assert.ok(treeCall.url.includes("region=NI"));
  });

  it("categoryTree uses custom region and MNW banner query", async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/mobile/user/login/guest")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      }
      return { ok: true, status: 200, json: async () => [] };
    };
    const client = new MobileFoodstuffsClient({ banner: "MNW", fetch });
    await client.categoryTree("nw-store", { region: "SI" });
    const call = calls.find((c) => c.url.includes("/mobile/v1/products/category"));
    assert.ok(call.url.includes("banner=newworld"));
    assert.ok(call.url.includes("region=SI"));
  });

  it("categoryTree passes response tree through", async () => {
    const tree = [
      { name: "Pantry", code: "pantry", children: [{ name: "Breakfast", code: "breakfast", children: [] }] },
      { name: "Household", code: "household", children: [] },
    ];
    const fetch = async (url, init) => {
      if (String(url).includes("/mobile/user/login/guest")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      }
      return { ok: true, status: 200, json: async () => tree };
    };
    const client = new MobileFoodstuffsClient({ fetch });
    const result = await client.categoryTree("store-1");
    assert.deepEqual(result, tree);
  });

  // ---- categoryPage ----

  it("categoryPage builds correct URL for cat0 only", async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/mobile/user/login/guest")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      }
      return { ok: true, status: 200, json: async () => ({ totalHits: 50, products: [] }) };
    };
    const client = new MobileFoodstuffsClient({ fetch });
    await client.categoryPage({ storeId: "store-1", cat0: "Pantry", page: 0 });
    const call = calls.find((c) => c.url.includes("/mobile/ecomm-products/PNS/store-1/category"));
    assert.ok(call, "category page call not found");
    assert.ok(call.url.includes("cat0=Pantry"));
    assert.ok(call.url.includes("sortOrder=Popularity"));
    assert.ok(call.url.includes("page=0"));
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.body, "[]");
  });

  it("categoryPage includes cat1 and cat2 query params when provided", async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/mobile/user/login/guest")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      }
      return { ok: true, status: 200, json: async () => ({ totalHits: 50, products: [] }) };
    };
    const client = new MobileFoodstuffsClient({ fetch });
    await client.categoryPage({ storeId: "store-1", cat0: "Pantry", cat1: "Breakfast", cat2: "Cereal", page: 2 });
    const call = calls.find((c) => c.url.includes("/mobile/ecomm-products/PNS/store-1/category"));
    assert.ok(call.url.includes("cat0=Pantry"));
    assert.ok(call.url.includes("cat1=Breakfast"));
    assert.ok(call.url.includes("cat2=Cereal"));
    assert.ok(call.url.includes("page=2"));
  });

  it("categoryPage uses MNW path segment for New World", async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/mobile/user/login/guest")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      }
      return { ok: true, status: 200, json: async () => ({ totalHits: 50, products: [] }) };
    };
    const client = new MobileFoodstuffsClient({ banner: "MNW", fetch });
    await client.categoryPage({ storeId: "nw-store", cat0: "Pantry", page: 0 });
    const call = calls.find((c) => c.url.includes("/mobile/ecomm-products/MNW/nw-store/category"));
    assert.ok(call, "MNW segment not found");
  });

  it("categoryPage passes envelope through", async () => {
    const envelope = { totalHits: 100, numberOfPages: 2, page: 0, products: [{ productId: "123", price: 500 }] };
    const fetch = async (url, init) => {
      if (String(url).includes("/mobile/user/login/guest")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      }
      return { ok: true, status: 200, json: async () => envelope };
    };
    const client = new MobileFoodstuffsClient({ fetch });
    const result = await client.categoryPage({ storeId: "s1", cat0: "Pantry", page: 0 });
    assert.deepEqual(result, envelope);
  });

  it("URL-encodes category names with spaces and special chars", async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("/mobile/user/login/guest")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      }
      return { ok: true, status: 200, json: async () => ({ totalHits: 50, products: [] }) };
    };
    const client = new MobileFoodstuffsClient({ fetch });
    await client.categoryPage({ storeId: "s1", cat0: "Chilled & Dairy", cat1: "Ice Cream & Novelties", page: 0 });
    const call = calls.find((c) => c.url.includes("/mobile/ecomm-products/"));
    assert.ok(call.url.includes("cat0=Chilled+%26+Dairy"));
    assert.ok(call.url.includes("cat1=Ice+Cream+%26+Novelties"));
    // Should not have unencoded & in the query string
    assert.ok(!call.url.includes("cat0=Chilled & Dairy"));
  });

  it("throws on non-ok response", async () => {
    const fetch = async (url, init) => {
      if (String(url).includes("/mobile/user/login/guest")) {
        return { ok: true, status: 200, json: async () => ({ access_token: "t", expires_in: 3600 }) };
      }
      return { ok: false, status: 500, statusText: "Server Error" };
    };
    // Exhausts the 2 retryable attempts (linear backoff) before rejecting;
    // retryBackoffMs: 1 keeps that semantics without 9s of real sleeps.
    const client = new MobileFoodstuffsClient({ fetch, retryBackoffMs: 1 });
    await assert.rejects(
      () => client.categoryPage({ storeId: "s1", cat0: "Pantry", page: 0 }),
      /Mobile request.*failed: 500 Server Error/,
    );
  });

  // ---- toPriceObservation re-export ----

  it("re-exports toPriceObservation from foodstuffs adapter", () => {
    assert.equal(typeof toPriceObservation, "function");
  });
});