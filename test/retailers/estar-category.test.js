import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseWindowJson,
  parseEstarItems,
  mapEstarItem,
  EstarCategoryClient,
} from "../../retailers/_lib/estar-category.js";
import { parseObservation } from "../../src/domain/observation.js";

const ITEM = {
  productid: 125404,
  description: "The People's Rose 750ml",
  label: "The People's",
  stylecolour: {
    urlkey: "the-peoples-rose-750ml-230496",
    variants: [
      {
        barcode: "230496",
        currency: "NZD",
        baseunitprice: "14.99",
        unitprice: "12.99",
      },
    ],
  },
  images: [{ src: "https://img.example/rose.jpg" }],
};

const PAYLOAD = {
  type: "category",
  categoryid: 5,
  items: [ITEM],
  pagination: { currentPage: 1, itemsPerPage: 24, totalItems: 7304 },
};

test("parseWindowJson parses plain and spread-payload assignments", () => {
  const plain = parseWindowJson(`<script>window.category = ${JSON.stringify(PAYLOAD)};</script>`);
  assert.equal(plain.items.length, 1);
  const spread = parseWindowJson(
    `<script>window.category = { ...${JSON.stringify(PAYLOAD)} };</script>`,
  );
  assert.equal(spread.items.length, 1);
  assert.equal(parseWindowJson("<p>nothing here</p>"), undefined);
  assert.equal(parseWindowJson(undefined), undefined);
  assert.equal(parseWindowJson(null), undefined);
});

test("parseEstarItems tolerates missing arrays", () => {
  assert.deepEqual(parseEstarItems(PAYLOAD).length, 1);
  assert.deepEqual(parseEstarItems({}), []);
  assert.deepEqual(parseEstarItems(undefined), []);
});

test("mapEstarItem maps variant prices, brand, and skips junk barcodes", () => {
  const store = { retailer: "llexample", scopeId: "online", name: "LL", origin: "https://llexample.co.nz" };
  const spec = mapEstarItem(ITEM, store);
  assert.equal(spec.retailerProductId, "125404");
  assert.equal(spec.name, "The People's Rose 750ml");
  assert.equal(spec.brand, "The People's");
  // barcode 230496 is a 6-digit stock code: not trusted as a GTIN
  assert.equal(spec.gtin, undefined);
  assert.equal(spec.regularCents, 1499);
  assert.equal(spec.promoCents, 1299);
});

test("live-shaped variant: boolean saleprice is not a price; variant hidewasprice suppresses promo", () => {
  const store = { retailer: "llexample", scopeId: "online", name: "LL", origin: "https://llexample.co.nz" };
  const item = {
    ...ITEM,
    stylecolour: {
      ...ITEM.stylecolour,
      variants: [
        { unitprice: "12.99", saleprice: false, originalunitprice: "14.99", hidewasprice: true },
      ],
    },
  };
  const spec = mapEstarItem(item, store);
  assert.equal(spec.regularCents, 1299);
  assert.equal(spec.promoCents, undefined);
});

test("EstarCategoryClient walks server-paginated categories and stops on duplicates", async () => {
  const makeItem = (id) => ({
    ...ITEM,
    productid: id,
    stylecolour: {
      ...ITEM.stylecolour,
      variants: [{ unitprice: "12.99", baseunitprice: null }],
    },
  });
  const pages = {
    1: [125404],
    2: [125405],
    3: [125404], // duplicate -> the walk stops here
  };
  const client = new EstarCategoryClient({
    slug: "llexample",
    origin: "https://llexample.co.nz",
    categories: ["wine"],
    pageParam: "p",
    fetch: async (url) => {
      const page = Number(new URL(url).searchParams.get("p") ?? 1);
      const ids = pages[page];
      if (!ids) throw new Error(`unexpected page ${page}`);
      const payload = { ...PAYLOAD, items: ids.map(makeItem) };
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => undefined },
        body: {},
        text: async () => `<script>window.category = { ...${JSON.stringify(payload)} };</script>`,
      };
    },
  });
  const observations = await client.collectProducts({ observedAt: "2026-09-06T00:00:00.000Z" });
  assert.equal(observations.length, 2);
  for (const observation of observations) parseObservation(observation);
  assert.deepEqual(observations.map((o) => o.product.id).sort(), ["llexample:125404", "llexample:125405"]);
  assert.deepEqual(observations[0].product.categories, ["wine"]);
});
