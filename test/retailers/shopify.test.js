import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseShopifyProducts,
  toShopifyObservations,
  ShopifyCatalogClient,
} from "../../retailers/_lib/shopify.js";
import { parseObservation } from "../../src/domain/observation.js";

const STORE = {
  origin: "https://shop.example",
  retailer: "shopexample",
  scopeId: "online",
  name: "Shop Example Online",
};

function productFixture(overrides = {}) {
  return {
    id: 111,
    handle: "test-powder",
    title: "Test Powder 500g",
    vendor: "TestBrand",
    product_type: "Supplements",
    tags: ["vegan", "sale"],
    images: [{ src: "https://cdn.example/powder.jpg" }],
    variants: [
      {
        id: 9001,
        price: "29.90",
        compare_at_price: null,
        barcode: "9412345678901",
      },
    ],
    ...overrides,
  };
}

test("parseShopifyProducts extracts the products array and tolerates junk", () => {
  assert.deepEqual(parseShopifyProducts({ products: [productFixture()] }).length, 1);
  assert.deepEqual(parseShopifyProducts({}), []);
  assert.deepEqual(parseShopifyProducts(undefined), []);
  assert.deepEqual(parseShopifyProducts({ products: "nope" }), []);
});

test("toShopifyObservations maps a simple variant to a valid observation", () => {
  const [observation] = toShopifyObservations(productFixture(), STORE, {
    observedAt: "2026-09-06T00:00:00.000Z",
  });
  parseObservation(observation); // throws on contract violations
  assert.equal(observation.product.id, "shopexample:9001");
  assert.equal(observation.product.name, "Test Powder 500g");
  assert.equal(observation.product.brand, "TestBrand");
  assert.equal(observation.product.gtin, "9412345678901");
  assert.deepEqual(observation.product.categories, ["Supplements", "vegan", "sale"]);
  assert.equal(observation.price.regularCents, 2990);
  assert.equal(observation.price.promoCents, undefined);
  assert.equal(observation.store.id, "shopexample:online");
  assert.equal(observation.store.retailer, "shopexample");
  assert.equal(observation.source.adapter, "shopexample");
  assert.equal(observation.source.url, "https://shop.example/products/test-powder");
});

test("compare_at_price produces a promo observation with derived savings", () => {
  const [observation] = toShopifyObservations(
    productFixture({
      variants: [{ id: 9002, price: "19.90", compare_at_price: "29.90", barcode: null }],
    }),
    STORE,
  );
  parseObservation(observation);
  assert.equal(observation.price.regularCents, 2990);
  assert.equal(observation.price.promoCents, 1990);
  assert.equal(observation.promotion.saveCents, 1000);
  assert.equal(observation.promotion.savePercent, 33.44);
});

test("zero-priced and junk variants are skipped; valid siblings survive", () => {
  const observations = toShopifyObservations(
    productFixture({
      variants: [
        { id: 1, price: "0.00", compare_at_price: null },
        { id: 2, price: "10.00", compare_at_price: null },
      ],
    }),
    STORE,
  );
  assert.deepEqual(observations.map((o) => o.product.id), ["shopexample:2"]);
});

test("multi-variant products emit one observation per variant", () => {
  const observations = toShopifyObservations(
    productFixture({
      variants: [
        { id: 1, price: "10.00", compare_at_price: null },
        { id: 2, price: "12.00", compare_at_price: "15.00" },
      ],
    }),
    STORE,
  );
  assert.equal(observations.length, 2);
  for (const observation of observations) parseObservation(observation);
});

test("collectProducts walks until a short page and dedupes by product id", async () => {
  const pages = [
    [productFixture(), productFixture({ id: 222, handle: "b", variants: [{ id: 3002, price: "5.00" }] })],
    // duplicate product id 222 must not double-emit; 333 has no variants
    [productFixture({ id: 222, handle: "b", variants: [{ id: 3002, price: "5.00" }] }),
      productFixture({ id: 333, handle: "c", variants: [] })],
  ];
  const client = new ShopifyCatalogClient({
    slug: "shopexample",
    origin: "https://shop.example",
    fetch: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return {
        ok: true,
        status: 200,
        headers: { get: () => undefined },
        json: async () => ({ products: pages[page - 1] ?? [] }),
      };
    },
  });
  const observations = await client.collectProducts({ limit: 2 });
  const ids = observations.map((o) => o.product.id).sort();
  assert.deepEqual(ids, ["shopexample:3002", "shopexample:9001"].sort());
});
