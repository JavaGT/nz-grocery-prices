import assert from "node:assert/strict";
import { test } from "node:test";
import { mapMagentoItem, MagentoGraphqlClient } from "../../retailers/_lib/magento-graphql.js";
import { parseObservation } from "../../src/domain/observation.js";

const ITEM = {
  id: 4623650,
  sku: "SP-123",
  name: "2XU Run Belt",
  url_key: "2xu-run-belt",
  price_range: {
    minimum_price: {
      final_price: { value: 50.99 },
      regular_price: { value: 59.99 },
      discount: { amount_off: 9, percent_off: 15 },
    },
  },
  small_image: { url: "https://img.example/belt.jpg" },
};

test("mapMagentoItem maps final/regular price pairs", () => {
  const store = { retailer: "rsexample", scopeId: "online", name: "RS", origin: "https://rsexample.co.nz" };
  const spec = mapMagentoItem(ITEM, store);
  const observation = spec;
  assert.equal(observation.retailerProductId, "4623650");
  assert.equal(observation.url, "https://rsexample.co.nz/2xu-run-belt");
  assert.equal(observation.regularCents, 5999);
  assert.equal(observation.promoCents, 5099);
  assert.equal(mapMagentoItem({ id: 1, name: "x", price_range: { minimum_price: { final_price: { value: 0 } } } }, store), undefined);
});

test("graphql() honors the timeout seam (aborts a hanging fetch)", async () => {
  const client = new MagentoGraphqlClient({
    slug: "rsexample",
    origin: "https://rsexample.co.nz",
    categories: ["clearance"],
    timeout: 20,
    fetch: (_url, init) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    }),
  });
  await assert.rejects(() => client.listCategoryTree(), /abort/);
});

function stubClient(responses) {
  return new MagentoGraphqlClient({
    slug: "rsexample",
    origin: "https://rsexample.co.nz",
    storeCode: "rebelsport",
    categories: ["clearance"],
    pageSize: 2,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body);
      if (body.query.includes("categories {")) {
        return { ok: true, status: 200, json: async () => responses.tree };
      }
      const page = body.variables.page;
      const payload = responses.products[page];
      if (!payload) throw new Error(`unexpected products page ${page}`);
      return { ok: true, status: 200, json: async () => ({ data: { products: payload } }) };
    },
  });
}

test("MagentoGraphqlClient resolves categories and paginates", async () => {
  const item = (id) => ({ ...ITEM, id, name: `Item ${id}` });
  const client = stubClient({
    tree: {
      data: {
        categories: {
          items: [{ id: 2, name: "Root", url_key: "", children: [
            { id: 77, name: "Clearance", url_key: "clearance", product_count: 4 },
          ] }],
        },
      },
    },
    products: {
      1: { total_count: 4, items: [item(1), item(2)] },
      2: { total_count: 4, items: [item(3), item(4)] },
      3: { total_count: 4, items: [] },
    },
  });
  const observations = await client.collectProducts({ observedAt: "2026-09-06T00:00:00.000Z" });
  assert.equal(observations.length, 4);
  for (const observation of observations) parseObservation(observation);
  assert.equal(observations[0].store.retailer, "rsexample");
  assert.equal(observations[0].price.promoCents, 5099);
});
