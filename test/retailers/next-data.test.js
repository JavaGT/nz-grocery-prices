import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseNextData,
  findDehydratedQuery,
  mapRawItem,
  NextDataClient,
} from "../../retailers/_lib/next-data.js";
import { parseObservation } from "../../src/domain/observation.js";

function makeHtml(payload) {
  return `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script></head></html>`;
}

const RAW = {
  code: "0431151",
  name: "100mm Assorted Potted Colour",
  brandname: "Greenlife",
  price: 1.8,
  currency: "NZD",
  imageurl: "https://img.example/pot.jpg",
  productroutingurl: "/100mm-assorted-potted-colour_p0431151",
};

const NEXT = {
  buildId: "test",
  props: {
    pageProps: {
      dehydratedState: {
        queries: [
          {
            queryKey: ["category-search", "/products/garden/plants", "zone", "store"],
            state: { data: { results: { 0: { raw: RAW } }, totalCount: 2823 } },
          },
        ],
      },
    },
  },
};

test("parseNextData extracts the JSON blob", () => {
  const json = parseNextData(makeHtml(NEXT));
  assert.equal(json.buildId, "test");
  assert.equal(parseNextData("<p>no data</p>"), undefined);
});

test("findDehydratedQuery locates the category-search entry", () => {
  const json = parseNextData(makeHtml(NEXT));
  const q = findDehydratedQuery(json, "category-search");
  assert.equal(q.state.data.totalCount, 2823);
  assert.equal(findDehydratedQuery(json, "nope"), undefined);
});

test("mapRawItem maps Coveo raw records", () => {
  const store = { retailer: "bnexample", scopeId: "online", name: "BN", origin: "https://bnexample.co.nz" };
  const spec = mapRawItem({ raw: RAW }, store);
  assert.equal(spec.retailerProductId, "0431151");
  assert.equal(spec.regularCents, 180);
  assert.equal(spec.brand, "Greenlife");
  assert.equal(spec.url, "https://bnexample.co.nz/100mm-assorted-potted-colour_p0431151");
});

test("NextDataClient paginates leaf categories", async () => {
  const makeData = (ids) => ({
    results: Object.fromEntries(ids.map((id, i) => [i, { raw: { ...RAW, code: id, name: `Item ${id}` } }])),
    totalCount: ids.length,
  });
  const pages = {
    1: ["a1", "a2"],
    2: ["a3"],
    3: [],
  };
  const client = new NextDataClient({
    slug: "bnexample",
    origin: "https://bnexample.co.nz",
    categories: ["products/garden/plants"],
    pageSize: 2,
    fetch: async (url) => {
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      const ids = pages[page];
      if (!ids) throw new Error(`unexpected page ${page}`);
      const payload = {
        props: {
          pageProps: {
            dehydratedState: {
              queries: [
                {
                  queryKey: ["category-search", "/products/garden/plants", "z", "s"],
                  state: { data: makeData(ids) },
                },
              ],
            },
          },
        },
      };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => undefined },
        body: {},
        text: async () => makeHtml(payload),
      };
    },
  });
  const observations = await client.collectProducts({ maxPages: 3, observedAt: "2026-09-06T00:00:00.000Z" });
  assert.equal(observations.length, 3);
  for (const observation of observations) parseObservation(observation);
  assert.ok(observations[0].source.url.startsWith("https://bnexample.co.nz/"));
});
