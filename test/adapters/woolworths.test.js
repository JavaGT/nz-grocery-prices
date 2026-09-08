import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toWoolworthsObservation, WoolworthsClient } from "../../src/adapters/woolworths.js";

const fulfilment = { fulfilmentStoreId: "1234", address: "Royal Oak" };

describe("toWoolworthsObservation", () => {

  it("extracts a special observation", () => {
    const product = {
      type: "Product",
      name: "Anchor Blue Milk 2L",
      barcode: "94171006",
      variety: null,
      brand: "Anchor",
      slug: "anchor-blue-milk-2l",
      sku: "5251234",
      unit: "ea",
      price: {
        originalPrice: 5.49,
        salePrice: 4.49,
        savePrice: 1.00,
        savePercentage: 18,
        isClubPrice: false,
        isSpecial: true,
        promotionStartDate: "2026-07-10",
        promotionEndDate: "2026-07-20",
      },
      images: { small: "https://example.com/small.jpg", big: "https://example.com/big.jpg" },
      size: { cupPrice: 2.25, cupMeasure: "100ml", volumeSize: "2L" },
      productTag: { tagType: "IsSpecial" },
      departments: [{ id: "1", name: "Dairy" }],
    };
    const result = toWoolworthsObservation(product, fulfilment);
    assert.equal(result.price.regularCents, 549);
    assert.equal(result.price.promoCents, 449);
    assert.equal(result.promotion.type, "SPECIAL");
    assert.equal(result.store.retailer, "woolworths");
    assert.equal(result.store.id, "woolworths:1234");
    assert.equal(result.product.id, "woolworths:5251234");
  });

  it("extracts a club price observation", () => {
    const product = {
      name: "Anchor Blue Milk 2L",
      barcode: "94171006",
      brand: "Anchor",
      slug: "anchor-blue-milk-2l",
      sku: "5251234",
      price: {
        originalPrice: 5.49,
        salePrice: 4.49,
        isClubPrice: true,
        isSpecial: false,
      },
      size: { volumeSize: "2L" },
      departments: [],
    };
    const result = toWoolworthsObservation(product, fulfilment);
    assert.equal(result.price.memberCents, 449);
    assert.equal(result.promotion.type, "MEMBER_PRICE");
    assert.equal(result.promotion.memberOnly, true);
  });

  it("returns undefined when sku is missing", () => {
    const product = {
      name: "Anchor Blue Milk 2L",
      price: { originalPrice: 5.49 },
    };
    const result = toWoolworthsObservation(product, fulfilment);
    assert.equal(result, undefined);
  });

  it("returns undefined when fulfilmentStoreId is missing", () => {
    const product = {
      sku: "5251234",
      name: "Anchor Blue Milk 2L",
      price: { originalPrice: 5.49 },
    };
    const result = toWoolworthsObservation(product, {});
    assert.equal(result, undefined);
  });

  it("returns undefined when price is missing entirely", () => {
    const product = {
      sku: "5251234",
      name: "Anchor Blue Milk 2L",
    };
    const result = toWoolworthsObservation(product, fulfilment);
    assert.equal(result, undefined);
  });

  it("appends size/volumeSize to name", () => {
    const product = {
      sku: "5251234",
      name: "Anchor Blue Milk",
      barcode: "94171006",
      brand: "Anchor",
      size: { cupPrice: 2.25, cupMeasure: "100ml", volumeSize: "2L" },
      price: { originalPrice: 5.49 },
      departments: [],
    };
    const result = toWoolworthsObservation(product, fulfilment);
    assert.equal(result.product.name, "Anchor Blue Milk 2L");
  });

  it("sets gtin from barcode", () => {
    const product = {
      sku: "5251234",
      name: "Anchor Blue Milk 2L",
      barcode: "94171006",
      price: { originalPrice: 5.49 },
      departments: [],
    };
    const result = toWoolworthsObservation(product, fulfilment);
    assert.equal(result.product.gtin, "94171006");
  });

  it("maps departments to categories", () => {
    const product = {
      sku: "5251234",
      name: "Anchor Blue Milk 2L",
      price: { originalPrice: 5.49 },
      departments: [{ id: "1", name: "Dairy" }],
    };
    const result = toWoolworthsObservation(product, fulfilment);
    assert.deepEqual(result.product.categories, ["Dairy"]);
  });

  it("respects options.observedAt", () => {
    const product = {
      sku: "5251234",
      name: "Anchor Blue Milk 2L",
      price: { originalPrice: 5.49 },
      departments: [],
    };
    const result = toWoolworthsObservation(product, fulfilment, { observedAt: "2026-07-17T12:00:00.000Z" });
    assert.equal(result.observedAt, "2026-07-17T12:00:00.000Z");
  });

  it("tolerates a missing departments array (no categories, no crash)", () => {
    const product = {
      sku: "5251234",
      name: "Anchor Blue Milk 2L",
      price: { originalPrice: 5.49 },
    };
    const result = toWoolworthsObservation(product, fulfilment);
    assert.equal(result.product.categories, undefined);
    assert.equal(result.product.id, "woolworths:5251234");
  });

  it("tolerates a non-array departments payload (no categories, no crash)", () => {
    const product = {
      sku: "5251234",
      name: "Anchor Blue Milk 2L",
      price: { originalPrice: 5.49 },
      departments: "Dairy", // malformed: pre-hardening this crashed .map
    };
    const result = toWoolworthsObservation(product, fulfilment);
    assert.equal(result.product.categories, undefined);
    assert.equal(result.product.id, "woolworths:5251234");
  });

  it("keeps name optional when the product has no name but has a size", () => {
    const product = {
      sku: "5251234",
      price: { originalPrice: 5.49 },
      size: { volumeSize: "2L" },
      departments: [],
    };
    const result = toWoolworthsObservation(product, fulfilment);
    assert.equal(result.product.name, undefined);
    assert.equal(JSON.parse(JSON.stringify(result)).product.name, undefined,
      "serialized output must omit name, not render the string \"undefined\"");
  });

  it("treats a blank name as missing", () => {
    const product = {
      sku: "5251234",
      name: "   ",
      price: { originalPrice: 5.49 },
      size: { volumeSize: "2L" },
      departments: [],
    };
    const result = toWoolworthsObservation(product, fulfilment);
    assert.equal(result.product.name, undefined);
  });

});

describe("WoolworthsClient", () => {

  function jsonResponse(payload, { status = 200 } = {}) {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
        controller.close();
      },
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      headers: new Map(),
      body: stream,
    };
  }

  it("stops paging when a page returns no items, even with an inflated totalItems", async () => {
    const pages = [
      jsonResponse({
        isSuccessful: true,
        context: { fulfilment: { fulfilmentStoreId: "1234", address: "Royal Oak" } },
        products: { items: [{ sku: "1", name: "One", price: { originalPrice: 1.0 }, departments: [] }], totalItems: 500 },
      }),
      jsonResponse({
        isSuccessful: true,
        context: { fulfilment: { fulfilmentStoreId: "1234", address: "Royal Oak" } },
        products: { items: [], totalItems: 500 },
      }),
    ];
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return pages[calls - 1] ?? jsonResponse({});
    };
    const client = new WoolworthsClient({ fetch, origin: "https://example.test" });
    const observations = await client.collectDeals({ size: 100 });
    assert.equal(calls, 2, "must not request pages beyond the empty one");
    assert.equal(observations.length, 1);
  });

  it("names the malformed envelope when products.items is not an array", async () => {
    const fetch = async () => jsonResponse({
      isSuccessful: true,
      context: { fulfilment: { fulfilmentStoreId: "1234", address: "Royal Oak" } },
      products: { items: { sku: "1" }, totalItems: 5 }, // malformed: object
    });
    const client = new WoolworthsClient({ fetch, origin: "https://example.test" });
    await assert.rejects(
      () => client.collectDeals(),
      /response envelope has a non-array products\.items/,
    );
  });

  it("names the malformed envelope when totalItems is non-numeric instead of silently truncating", async () => {
    // Pre-hardening, a non-numeric totalItems made the page math NaN, which
    // silently ended collection after page 1.
    const fetch = async () => jsonResponse({
      isSuccessful: true,
      context: { fulfilment: { fulfilmentStoreId: "1234", address: "Royal Oak" } },
      products: { items: [{ sku: "1", price: { originalPrice: 1.0 } }], totalItems: "many" },
    });
    const client = new WoolworthsClient({ fetch, origin: "https://example.test" });
    await assert.rejects(
      () => client.collectDeals(),
      /response envelope has a non-numeric products\.totalItems/,
    );
  });

  it("still pages when totalItems arrives as a numeric string", async () => {
    const page = (skus) => jsonResponse({
      isSuccessful: true,
      context: { fulfilment: { fulfilmentStoreId: "1234", address: "Royal Oak" } },
      products: {
        items: skus.map((sku) => ({ sku, price: { originalPrice: 1.0 } })),
        totalItems: "4",
      },
    });
    const pages = [page(["1", "2"]), page(["3", "4"])];
    let calls = 0;
    const fetch = async () => {
      calls += 1;
      return pages[calls - 1];
    };
    const client = new WoolworthsClient({ fetch, origin: "https://example.test" });
    const observations = await client.collectDeals({ size: 2 });
    assert.equal(calls, 2);
    assert.equal(observations.length, 4);
  });

  it("cancels the response body before throwing on a non-retryable error status", async () => {
    let cancelled = false;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("server exploded"));
        controller.close();
      },
      cancel() { cancelled = true; },
    });
    const fetch = async () => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      headers: new Map(),
      body: stream,
    });
    const client = new WoolworthsClient({ fetch, origin: "https://example.test" });
    await assert.rejects(() => client.listDeals(), /Woolworths \/api\/v1\/products\?.* failed: 500/);
    assert.equal(cancelled, true, "error body must be cancelled to release the connection");
  });

  it("sends the cookie as a request header and never leaks it into error messages", async () => {
    const cookie = "w_session=SECRET-COOKIE-VALUE; path=/";
    let requestHeaders;
    const failure = {
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: new Map(),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("denied"));
          controller.close();
        },
      }),
    };
    const fetch = async (_url, options) => {
      requestHeaders = options.headers;
      return failure;
    };
    const client = new WoolworthsClient({ fetch, origin: "https://example.test", cookie });
    await assert.rejects(() => client.listDeals());
    assert.equal(requestHeaders.cookie, cookie, "cookie must travel as the request cookie header");
    const parseFailure = {
      ok: true,
      status: 200,
      statusText: "",
      headers: new Map([["content-type", "text/html"]]),
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("<html>challenge</html>"));
          controller.close();
        },
      }),
    };
    const parseClient = new WoolworthsClient({
      fetch: async () => parseFailure,
      origin: "https://example.test",
      cookie,
      retry: false,
    });
    await assert.rejects(() => parseClient.listDeals(), (error) => {
      assert.ok(!error.message.includes("SECRET-COOKIE-VALUE"),
        "no error message may contain the cookie value");
      return true;
    });
  });

});