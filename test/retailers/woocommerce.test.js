import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WooStoreClient,
  parseWooProducts,
} from "../../retailers/_lib/woocommerce.js";
import { parseObservation } from "../../src/domain/observation.js";

const ORIGIN = "https://woo.example";

function makeClient(fetchImpl, overrides = {}) {
  return new WooStoreClient({
    slug: "wooexample",
    origin: ORIGIN,
    fetch: fetchImpl,
    ...overrides,
  });
}

function wooProduct(overrides = {}) {
  return {
    id: 42,
    name: "Test Merlot 750ml",
    permalink: `${ORIGIN}/product/test-merlot`,
    prices: {
      price: "1999",
      regular_price: "2499",
      sale_price: "1999",
      currency_minor_unit: 2,
    },
    images: [{ src: `${ORIGIN}/merlot.jpg` }],
    short_description: "<p>Nice</p>",
    ...overrides,
  };
}

const ERROR_BODY = {
  code: "rest_no_route",
  message: "No route was found matching the URL and request method.",
};

test("parseWooProducts passes arrays through and names non-array bodies", () => {
  assert.deepEqual(parseWooProducts([wooProduct()]).length, 1);
  assert.throws(
    () => parseWooProducts(ERROR_BODY, { operation: "woo wooexample p1" }),
    /woo wooexample p1: expected a products array, got object \(rest_no_route\)/,
  );
  assert.throws(
    () => parseWooProducts(undefined),
    /expected a products array, got undefined/,
  );
});

test("collectProducts tolerates a WP error body on page 1 like a dead retailer", async (t) => {
  const errorMock = t.mock.method(console, "error", () => {});
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => ERROR_BODY,
  });
  const observations = await makeClient(fetchImpl).collectProducts();
  assert.deepEqual(observations, []);
  assert.ok(errorMock.mock.callCount() >= 1);
});

test("collectProducts throws a named error when a later page returns an error body", async () => {
  const pages = [[wooProduct()], ERROR_BODY];
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => pages.shift(),
  });
  const walk = makeClient(fetchImpl, { pageSize: 1 }).collectProducts({
    maxPages: 3,
  });
  await assert.rejects(
    () => walk,
    /woo wooexample p2: expected a products array, got object \(rest_no_route\)/,
  );
});

test("collectProducts maps a normal page into valid observations", async () => {
  const pages = [[wooProduct()], []];
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => pages.shift(),
  });
  const [observation] = await makeClient(fetchImpl, {
    pageSize: 1,
  }).collectProducts();
  parseObservation(observation); // throws on contract violations
  assert.equal(observation.product.name, "Test Merlot 750ml");
  assert.equal(observation.price.regularCents, 2499);
  assert.equal(observation.price.promoCents, 1999);
});
