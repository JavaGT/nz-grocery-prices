import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FreshChoiceClient,
  parseFreshChoiceProducts,
  parseFreshChoiceStoreList,
  pageCount,
  toFreshChoiceObservation,
} from "../../src/adapters/freshchoice.js";

const freshchoiceHtml = `<div class="talker special talker--Special" data-talker id="line_12345">
  <a href="/product/anchor-milk-2l"><figure><img src="https://example.com/milk.jpg"></figure></a>
  <div class="talker__name  " title="Anchor Blue Milk 2L"><span class="talker__product-name">Anchor Blue Milk 2L</span></div>
  <strong class="price__sell">$ 5.99</strong>
  <span class="talker__prices__was">$ 7.99</span>
  <span class="price__units">ea</span>
  <span class="talker__prices__comparison">$ 2.99 / 100g</span>
</div>`;

const store = { id: "queenstown", name: "FreshChoice Queenstown" };

describe("parseFreshChoiceProducts", () => {

  it("parses a product from HTML", () => {
    const result = parseFreshChoiceProducts(freshchoiceHtml);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "12345");
    assert.equal(result[0].sellCents, 599);
    assert.equal(result[0].wasCents, 799);
    assert.equal(result[0].isSpecial, true);
  });

  it("extracts product name, unit, and image", () => {
    const result = parseFreshChoiceProducts(freshchoiceHtml);
    assert.ok(result[0].name.includes("Anchor"));
    assert.equal(result[0].unit, "ea");
    assert.ok(result[0].image.startsWith("https://"));
  });

  it("returns empty array for HTML with no products", () => {
    const result = parseFreshChoiceProducts("<html><body></body></html>");
    assert.deepEqual(result, []);
  });

  it("returns empty array for non-string input instead of crashing", () => {
    // Breadth feeds this parser crawled bodies; a non-string must yield no
    // products, not a .matchAll TypeError.
    assert.deepEqual(parseFreshChoiceProducts(undefined), []);
    assert.deepEqual(parseFreshChoiceProducts(null), []);
    assert.deepEqual(parseFreshChoiceProducts(""), []);
  });

});

describe("pageCount", () => {
  it("reads the highest aria-label page marker", () => {
    const html = `<span aria-label="Page 1"></span><span aria-label="Page 4"></span>`;
    assert.equal(pageCount(html), 4);
  });

  it("counts a non-string body as a single-page listing instead of crashing", () => {
    assert.equal(pageCount(undefined), 1);
    assert.equal(pageCount(null), 1);
    assert.equal(pageCount(""), 1);
  });
});

describe("decodeHtml entity hardening", () => {

  it("decodes valid decimal and hex character references", () => {
    const html = freshchoiceHtml.replace(
      'title="Anchor Blue Milk 2L"',
      'title="Anchor &#65;1 Milk &#x2B; pack"',
    );
    const result = parseFreshChoiceProducts(html);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "Anchor A1 Milk + pack");
  });

  it("leaves out-of-range character references verbatim instead of crashing", () => {
    // String.fromCodePoint would throw RangeError on these code points.
    const html = freshchoiceHtml.replace(
      'title="Anchor Blue Milk 2L"',
      'title="Milk &#1114112; hostile &#x110000;"',
    );
    const result = parseFreshChoiceProducts(html);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "Milk &#1114112; hostile &#x110000;");
  });

});

describe("FreshChoiceClient response-body cap", () => {
  // Double whose declared Content-Length exceeds readBodyText's 20 MiB cap;
  // text() throwing proves the body is never read.
  const oversized = {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get: (name) => (String(name).toLowerCase() === "content-length" ? "22020096" : null),
    },
    text: async () => {
      throw new Error("body must not be read past the cap");
    },
  };

  it("refuses listStores responses declaring more than the 20 MiB cap", async () => {
    const client = new FreshChoiceClient({ fetch: async () => oversized });
    await assert.rejects(client.listStores(), /declared Content-Length 22020096 exceeds/);
  });

  it("refuses oversized search responses before reading the body", async () => {
    const client = new FreshChoiceClient({ fetch: async () => oversized });
    await assert.rejects(client.searchProducts({ query: "milk" }), /exceeds the 20971520 byte cap/);
  });

});

const storeListHtml = `
<div class="StoreCard StoreCard--WithStoreAttributes">
<span class="StoreCard__Name">Queenstown</span>
<span class="StoreCard__Details">
<strong>Open today  7:00 am - 10:00 pm</strong>
<br>
64 Gorge Road
<br>
Queenstown 9300
<br>
</span>
<div class="StoreCard__CallToActions">
<a href="https://queenstown.store.freshchoice.co.nz/catalogues">Catalogue</a>
<a href="http://maps.google.com?q=64+Gorge+Road%2C+Queenstown%2C+Otago%2C+9300">Directions</a>
</div>
</div>
<div class="StoreCard StoreCard--WithStoreAttributes">
<span class="StoreCard__Name">Avondale</span>
<span class="StoreCard__Details">
<strong>Open today  7:00 am - 9:00 pm</strong>
<br>
2021 Great North Road
<br>
Auckland 1026
</span>
<a href="https://avondale.store.freshchoice.co.nz/catalogues">Catalogue</a>
</div>
`;

describe("parseFreshChoiceStoreList", () => {
  it("parses store cards into origin/slug/name records", () => {
    const stores = parseFreshChoiceStoreList(storeListHtml);
    assert.equal(stores.length, 2);
    const qt = stores.find((s) => s.slug === "queenstown");
    assert.ok(qt);
    assert.equal(qt.id, "freshchoice:queenstown");
    assert.equal(qt.origin, "https://queenstown.store.freshchoice.co.nz");
    assert.match(qt.name, /Queenstown/);
    assert.equal(stores.find((s) => s.slug === "avondale")?.origin,
      "https://avondale.store.freshchoice.co.nz");
  });

  it("deduplicates by slug and sorts by name", () => {
    const stores = parseFreshChoiceStoreList(
      storeListHtml + storeListHtml.replaceAll("Queenstown", "Queenstown"),
    );
    assert.equal(stores.length, 2);
    assert.ok(stores[0].name.localeCompare(stores[1].name, "en-NZ") <= 0);
  });

  it("falls back to origin-only links when cards are missing", () => {
    const stores = parseFreshChoiceStoreList(
      'Visit <a href="https://huntly.store.freshchoice.co.nz/">Huntly</a>',
    );
    assert.equal(stores.length, 1);
    assert.equal(stores[0].slug, "huntly");
    assert.equal(stores[0].origin, "https://huntly.store.freshchoice.co.nz");
  });
});

describe("toFreshChoiceObservation", () => {

  it("produces a valid observation", () => {
    const products = parseFreshChoiceProducts(freshchoiceHtml);
    const result = toFreshChoiceObservation(products[0], store);
    assert.equal(result.product.id, "freshchoice:12345");
    assert.equal(result.product.name, "Anchor Blue Milk 2L");
    assert.equal(result.price.regularCents, 799);
    assert.equal(result.price.promoCents, 599);
    assert.equal(result.store.retailer, "freshchoice");
    assert.equal(result.promotion.type, "SPECIAL");
    assert.equal(result.promotion.saveCents, 200);
  });

  it("returns undefined when sellCents is missing", () => {
    const result = toFreshChoiceObservation({ id: "12345", name: "Test" }, store);
    assert.equal(result, undefined);
  });

  it("returns undefined when id is missing", () => {
    const result = toFreshChoiceObservation({ name: "Test", sellCents: 599 }, store);
    assert.equal(result, undefined);
  });

  it("respects options.observedAt", () => {
    const products = parseFreshChoiceProducts(freshchoiceHtml);
    const result = toFreshChoiceObservation(products[0], store, { observedAt: "2026-07-17T12:00:00.000Z" });
    assert.equal(result.observedAt, "2026-07-17T12:00:00.000Z");
  });

});