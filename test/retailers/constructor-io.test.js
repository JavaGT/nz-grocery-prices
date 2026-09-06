import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConstructorSearchClient,
  mapConstructorItem,
  parseConstructorResults,
} from "../../retailers/_lib/constructor-io.js";

const STORE = { retailer: "kmexample", scopeId: "online", name: "KM", origin: "https://km.example" };

function clientOptions(overrides = {}) {
  return {
    slug: "kmexample",
    origin: "https://km.example",
    key: "key_test123",
    queries: ["toys"],
    ...overrides,
  };
}

function itemFixture(overrides = {}) {
  return {
    value: "Sprite 1.5L",
    data: { id: "P_43684687", uri: "/p/43684687", Brand: "Sprite" },
    variations: [{ data: { price: 3.5, apn: "9300675046018" } }],
    ...overrides,
  };
}

test("search sends the documented Constructor.io GET and parses results", async () => {
  const capture = {};
  const client = new ConstructorSearchClient(
    clientOptions({
      fetch: async (url, init) => {
        capture.url = String(url);
        capture.headers = init?.headers;
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => ({ response: { results: [itemFixture()] } }),
        };
      },
    }),
  );
  const json = await client.search("toys", 2);
  assert.equal(parseConstructorResults(json).length, 1);
  assert.equal(
    capture.url,
    "https://ac.cnstrc.com/search/toys?key=key_test123&num_results_per_page=100&page=2",
  );
  assert.equal(capture.headers.accept, "application/json");
});

test("a WAF page served with status 200 fails as a typed error, not SyntaxError", async () => {
  const client = new ConstructorSearchClient(
    clientOptions({
      retry: false,
      fetch: async () => ({
        ok: true,
        status: 200,
        headers: { get: () => "text/html" },
        text: async () => "<html>Access denied</html>",
      }),
    }),
  );
  await assert.rejects(
    client.search("toys"),
    (error) => {
      assert.match(error.message, /constructor kmexample "toys" p1/);
      assert.match(error.message, /expected JSON/);
      assert.match(error.message, /text\/html/);
      assert.match(error.message, /Access denied/);
      return true;
    },
  );
});

test("the configured timeout is honored — a wedged transport cannot hang the run", async () => {
  const client = new ConstructorSearchClient(
    clientOptions({
      timeout: 100,
      retry: false,
      fetch: (url, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => reject(init.signal.reason));
        }),
    }),
  );
  const started = Date.now();
  await assert.rejects(client.search("toys"), (error) => error.name === "TimeoutError");
  assert.ok(Date.now() - started < 5000);
});

test("mapConstructorItem derives cents, promo, and a validated GTIN", () => {
  const spec = mapConstructorItem(itemFixture({
    variations: [{ data: { price: 3.5, prices: [{ type: "list", amount: 4.3 }], apn: "9300675046018" } }],
  }), STORE);
  assert.equal(spec.retailerProductId, "43684687");
  assert.equal(spec.regularCents, 430);
  assert.equal(spec.promoCents, 350);
  assert.equal(spec.gtin, "9300675046018");
  assert.equal(spec.url, "https://km.example/p/43684687");
});
