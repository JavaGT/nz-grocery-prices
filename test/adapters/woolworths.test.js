import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toWoolworthsObservation } from "../../src/adapters/woolworths.js";

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

});