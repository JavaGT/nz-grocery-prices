import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseAlgoliaHits,
  toAlgoliaObservations,
  AlgoliaSearchClient,
} from "../../retailers/_lib/algolia.js";
import { parseObservation } from "../../src/domain/observation.js";

function hitFixture(overrides = {}) {
  return {
    Id: 42,
    objectID: "42",
    Name: "Cassels Milk Stout Bottles 6x328ml",
    SeName: "cassels-milk-stout-bottles-6x328ml",
    Sku: "9421904633018",
    ProductPrice: { PriceValue: 24.99, OldPriceValue: null },
    PictureModels: [{ ImageUrl: "https://img.example/stout.jpg" }],
    ...overrides,
  };
}

function mapHit(hit) {
  const price = Number(hit?.ProductPrice?.PriceValue);
  const regularCents = Number.isFinite(price) ? Math.round(price * 100) : undefined;
  if (regularCents === undefined || regularCents <= 0) return undefined;
  return {
    retailerProductId: String(hit.Id),
    name: hit.Name,
    url: `https://sl.example/${hit.SeName}`,
    gtin: String(hit.Sku).replace(/\D/g, ""),
    regularCents,
  };
}

test("parseAlgoliaHits tolerates junk", () => {
  assert.deepEqual(parseAlgoliaHits({ hits: [hitFixture()] }).length, 1);
  assert.deepEqual(parseAlgoliaHits({}), []);
  assert.deepEqual(parseAlgoliaHits(undefined), []);
});

test("toAlgoliaObservations maps hits through mapHit and dedupes", () => {
  const store = { retailer: "slexample", scopeId: "online", name: "SL", origin: "https://sl.example" };
  const observations = toAlgoliaObservations(
    [hitFixture(), hitFixture(), hitFixture({ Id: 43, Name: "Other", ProductPrice: { PriceValue: 0 } })],
    store,
    mapHit,
  );
  assert.equal(observations.length, 1);
  parseObservation(observations[0]);
  assert.equal(observations[0].product.id, "slexample:42");
  assert.equal(observations[0].price.regularCents, 2499);
});

function stubClient(pages, capture) {
  return new AlgoliaSearchClient({
    slug: "slexample",
    origin: "https://sl.example",
    appId: "APPID00AA",
    apiKey: "key",
    indexName: "Products",
    pageSize: 2,
    mapHit,
    fetch: async (url) => {
      capture.push(new URL(url));
      const page = Number(new URL(url).searchParams.get("page"));
      const filters = new URL(url).searchParams.get("numericFilters");
      const key = filters ?? `page${page}`;
      const payload = pages[key];
      if (!payload) throw new Error(`unexpected fetch ${url}`);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => undefined },
        json: async () => payload,
      };
    },
  });
}

test("collectProducts walks pages until nbPages is exhausted", async () => {
  const capture = [];
  const client = stubClient(
    {
      page0: { hits: [hitFixture({ Id: 1 })], nbPages: 2, page: 0 },
      page1: { hits: [hitFixture({ Id: 2 })], nbPages: 2, page: 1 },
    },
    capture,
  );
  const observations = await client.collectProducts({ observedAt: "2026-09-06T00:00:00.000Z" });
  assert.equal(observations.length, 2);
  assert.deepEqual(observations.map((o) => o.product.id).sort(), ["slexample:1", "slexample:2"]);
});

test("collectProducts slices by numeric attribute when pagination is capped", async () => {
  const capture = [];
  const client = stubClient(
    {
      // index pagination capped at 1000 records: only slice-0 pages exist
      page0: { hits: [hitFixture({ Id: 1 })], nbPages: 1, page: 0 },
      "Id>0,Id<=500": { hits: [hitFixture({ Id: 10 })], nbPages: 1, page: 0 },
      "Id>500,Id<=1000": { hits: [hitFixture({ Id: 700 })], nbPages: 1, page: 0 },
      "Id>1000,Id<=1500": { hits: [], nbPages: 0, page: 0 },
      "Id>1500,Id<=2000": { hits: [], nbPages: 0, page: 0 },
      "Id>2000,Id<=2500": { hits: [], nbPages: 0, page: 0 },
    },
    capture,
  );
  client.sliceAttribute = "Id";
  client.sliceStep = 500;
  const observations = await client.collectProducts({ observedAt: "2026-09-06T00:00:00.000Z" });
  assert.deepEqual(observations.map((o) => o.product.id).sort(), ["slexample:10", "slexample:700"]);
  assert.ok(capture.some((u) => u.searchParams.get("numericFilters") === "Id>500,Id<=1000"));
});
