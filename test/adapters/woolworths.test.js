import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CookieJar,
  parseWoolworthsPickupStores,
  toWoolworthsObservation,
  WoolworthsClient,
} from "../../src/adapters/woolworths.js";

const fulfilment = { fulfilmentStoreId: "1234", address: "Royal Oak" };

describe("CookieJar", () => {
  it("parses an initial cookie header and serializes it", () => {
    const jar = new CookieJar("a=1; b=two");
    assert.equal(jar.header(), "a=1; b=two");
  });

  it("stores Set-Cookie values from a response", () => {
    const jar = new CookieJar();
    jar.storeFromResponse({
      headers: {
        getSetCookie: () => [
          "ASP.NET_SessionId=abc; path=/; secure",
          "cw-laie=xyz; path=/",
          "gone=; path=/",
        ],
      },
    });
    assert.match(jar.header(), /ASP\.NET_SessionId=abc/);
    assert.match(jar.header(), /cw-laie=xyz/);
    assert.equal(jar.header().includes("gone="), false);
  });
});

describe("parseWoolworthsPickupStores", () => {
  const payload = {
    storeAreas: [
      {
        id: 494,
        name: "All Pick up locations",
        storeAddresses: [
          {
            id: 2811065,
            name: "Woolworths Queenstown",
            address: "30 Grant Road, Frankton",
          },
          {
            id: 1996677,
            name: "Woolworths Ponsonby",
            address: "4 Williamson Avenue",
          },
          {
            id: 999,
            name: "Paparoa Hall",
            address: "2056 Paparoa Valley Road",
          },
        ],
      },
      {
        id: 1,
        name: "Otago/Southland",
        storeAddresses: [
          {
            id: 2811065,
            name: "Woolworths Queenstown",
            address: "30 Grant Road, Frankton",
          },
        ],
      },
    ],
  };

  it("dedupes by pickup id and drops remote halls by default", () => {
    const stores = parseWoolworthsPickupStores(payload);
    assert.equal(stores.length, 2);
    assert.deepEqual(
      stores.map((s) => s.name).sort(),
      ["Woolworths Ponsonby", "Woolworths Queenstown"],
    );
    assert.equal(stores.find((s) => s.name.includes("Queenstown")).id, "2811065");
    assert.equal(
      stores.find((s) => s.name.includes("Queenstown")).pickupAddressId,
      2811065,
    );
  });

  it("can include remote pickup points", () => {
    const stores = parseWoolworthsPickupStores(payload, { includeRemote: true });
    assert.equal(stores.length, 3);
    assert.ok(stores.some((s) => s.name === "Paparoa Hall"));
  });
});

describe("WoolworthsClient store switching", () => {
  it("lists stores, switches pickup, and collects with that fulfilment", async () => {
    const calls = [];
    const fetch = async (url, options = {}) => {
      calls.push({ url: String(url), method: options.method ?? "GET", body: options.body });
      const path = String(url).replace("https://www.woolworths.co.nz", "");

      if (path.startsWith("/api/v1/products")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: {
            getSetCookie: () => ["ASP.NET_SessionId=sess1; path=/"],
          },
          text: async () =>
            JSON.stringify({
              isSuccessful: true,
              products: {
                totalItems: 1,
                items: [
                  {
                    sku: "909276",
                    name: "Anchor Milk 2L",
                    brand: "Anchor",
                    price: { originalPrice: 4.75, salePrice: 3.99, isSpecial: true },
                    size: { volumeSize: "2L" },
                    departments: [],
                  },
                ],
              },
              context: {
                fulfilment: {
                  fulfilmentStoreId: 9488,
                  address: "Woolworths Queenstown",
                  pickupAddressId: 2811065,
                  method: "Pickup",
                },
              },
            }),
        };
      }

      if (path === "/api/v1/addresses/pickup-addresses") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { getSetCookie: () => [] },
          text: async () =>
            JSON.stringify({
              storeAreas: [
                {
                  name: "All Pick up locations",
                  storeAddresses: [
                    {
                      id: 2811065,
                      name: "Woolworths Queenstown",
                      address: "30 Grant Road",
                    },
                  ],
                },
              ],
            }),
        };
      }

      if (path === "/api/v1/fulfilment/my/methods/pickup") {
        assert.equal(options.method, "PUT");
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { getSetCookie: () => [] },
          text: async () =>
            JSON.stringify({
              context: {
                fulfilment: {
                  fulfilmentStoreId: 9101,
                  address: "Woolworths Birkenhead",
                  method: "Pickup",
                },
              },
            }),
        };
      }

      if (path === "/api/v1/fulfilment/my/pickup-addresses") {
        assert.equal(options.method, "PUT");
        assert.equal(JSON.parse(options.body).addressId, 2811065);
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { getSetCookie: () => [] },
          text: async () =>
            JSON.stringify({
              context: {
                fulfilment: {
                  fulfilmentStoreId: 9488,
                  address: "Woolworths Queenstown",
                  pickupAddressId: 2811065,
                  method: "Pickup",
                },
              },
            }),
        };
      }

      throw new Error(`unexpected url ${url}`);
    };

    const client = new WoolworthsClient({ fetch, retry: false });
    const stores = await client.listStores();
    assert.equal(stores.length, 1);
    assert.equal(stores[0].pickupAddressId, 2811065);

    const selected = await client.setPickupStore(2811065);
    assert.equal(selected.id, "9488");
    assert.match(selected.name, /Queenstown/);

    const observations = await client.collectDeals({ maxPages: 1, size: 1 });
    assert.equal(observations.length, 1);
    assert.equal(observations[0].store.id, "woolworths:9488");
    assert.equal(observations[0].price.promoCents, 399);

    assert.ok(calls.some((c) => c.url.includes("/methods/pickup")));
    assert.ok(calls.some((c) => c.url.includes("/pickup-addresses") && c.method === "PUT"));
  });

  it("resolves a store by name substring", async () => {
    const fetch = async (url) => {
      const path = String(url).replace("https://www.woolworths.co.nz", "");
      if (path.startsWith("/api/v1/products")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { getSetCookie: () => [] },
          text: async () =>
            JSON.stringify({
              products: { totalItems: 0, items: [] },
              context: {
                fulfilment: { fulfilmentStoreId: 9171, address: "Glenfield" },
              },
            }),
        };
      }
      if (path === "/api/v1/addresses/pickup-addresses") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { getSetCookie: () => [] },
          text: async () =>
            JSON.stringify({
              storeAreas: [
                {
                  storeAddresses: [
                    { id: 1, name: "Woolworths Queenstown", address: "Frankton" },
                    { id: 2, name: "Woolworths Ponsonby", address: "Auckland" },
                  ],
                },
              ],
            }),
        };
      }
      throw new Error(url);
    };
    const client = new WoolworthsClient({ fetch, retry: false });
    const store = await client.resolveStore("queenstown");
    assert.equal(store.pickupAddressId, 1);
  });
});

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

});