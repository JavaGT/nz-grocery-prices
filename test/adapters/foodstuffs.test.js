import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toPriceObservation } from "../../src/adapters/foodstuffs.js";

const store = { id: "royaloak", name: "PAK'nSAVE Royal Oak", address: "1 Main St", region: "Auckland" };

describe("toPriceObservation (foodstuffs)", () => {

  it("extracts a normal product observation", () => {
    const product = {
      productId: "5004821-EA-000",
      brand: "Anchor",
      name: "Anchor Blue Milk",
      displayName: "2L",
      singlePrice: {
        price: 860,
        promoId: null,
        comparativePrice: { pricePerUnit: 4.30, unitQuantity: 1, unitQuantityUom: "L", measureDescription: "per 1L" },
      },
      multiPrice: { price: null },
      price: 860,
      promotions: [],
      decalCode: null,
      decalImageUrl: null,
      categoryTrees: [{ level0: "Pantry", level1: "Breakfast", level2: null }],
      categories: null,
      productImageUrls: { "400": "https://example.com/milk.jpg" },
      unitPrice: null,
    };
    const result = toPriceObservation(product, store);
    assert.equal(result.product.id, "foodstuffs:5004821-ea-000");
    assert.equal(result.product.name, "Anchor Blue Milk 2L");
    assert.equal(result.product.brand, "Anchor");
    assert.deepEqual(result.product.categories, ["Pantry", "Breakfast"]);
    assert.deepEqual(result.product.images, { "400": "https://example.com/milk.jpg" });
    assert.equal(result.store.id, "paknsave:royaloak");
    assert.equal(result.store.retailer, "paknsave");
    assert.equal(result.store.name, "PAK'nSAVE Royal Oak");
    assert.equal(result.store.address, "1 Main St");
    assert.equal(result.store.region, "Auckland");
    assert.equal(result.price.currency, "NZD");
    assert.equal(result.price.regularCents, 860);
    assert.deepEqual(result.price.comparative, { pricePerUnit: 4.30, unitQuantity: 1, unitQuantityUom: "L", measureDescription: "per 1L" });
    assert.equal(result.source.retailerProductId, "5004821-EA-000");
    assert.equal(result.source.adapter, "foodstuffs-paknsave");
    assert.ok(result.observedAt);
  });

  it("uses product.price when singlePrice is missing", () => {
    const product = {
      productId: "5004821-EA-000",
      name: "Anchor Blue Milk",
      displayName: "2L",
      price: 950,
    };
    const result = toPriceObservation(product, store);
    assert.equal(result.price.regularCents, 950);
  });

  it("returns undefined when no price field is present", () => {
    const product = {
      productId: "5004821-EA-000",
      name: "Anchor Blue Milk",
    };
    const result = toPriceObservation(product, store);
    assert.equal(result, undefined);
  });

  it("returns undefined when price is not an integer", () => {
    const product = {
      productId: "5004821-EA-000",
      name: "Anchor Blue Milk",
      price: "8.99",
    };
    const result = toPriceObservation(product, store);
    assert.equal(result, undefined);
  });

  it("picks best promotion", () => {
    const product = {
      productId: "5004821-EA-000",
      name: "Anchor Blue Milk",
      displayName: "2L",
      singlePrice: { price: 860, promoId: null, comparativePrice: null },
      price: 860,
      promotions: [
        { promoId: "456", rewardType: "SPECIAL", threshold: null, limit: null, cardDependencyFlag: false, bestPromotion: false, decalImageUrl: null },
        { promoId: "123", rewardType: "SPECIAL", threshold: null, limit: null, cardDependencyFlag: false, bestPromotion: true, decalImageUrl: "https://example.com/badge.png" },
      ],
    };
    const result = toPriceObservation(product, store);
    assert.ok(result.promotion.id.includes("123"));
    assert.equal(result.promotion.type, "SPECIAL");
    assert.equal(result.promotion.imageUrl, "https://example.com/badge.png");
  });

  it("falls back to decal when no promotions array", () => {
    const product = {
      productId: "5004821-EA-000",
      name: "Anchor Blue Milk",
      displayName: "2L",
      singlePrice: { price: 860, promoId: null, comparativePrice: null },
      price: 860,
      decalCode: "DECAL123",
      decalImageUrl: "https://example.com/decal.png",
    };
    const result = toPriceObservation(product, store);
    assert.equal(result.promotion.type, "SPECIAL");
    assert.equal(result.promotion.id, "decal:DECAL123");
    assert.equal(result.promotion.imageUrl, "https://example.com/decal.png");
  });

  it("uses newworld retailer prefix when options.retailer=newworld", () => {
    const product = {
      productId: "5004821-EA-000",
      name: "Anchor Blue Milk",
      displayName: "2L",
      singlePrice: { price: 860, promoId: null, comparativePrice: null },
      price: 860,
    };
    const result = toPriceObservation(product, store, { retailer: "newworld" });
    assert.ok(result.store.id.startsWith("newworld:"));
    assert.equal(result.source.adapter, "foodstuffs-newworld");
  });

  it("joins name and displayName", () => {
    const product = {
      productId: "5004821-EA-000",
      name: "Anchor Blue Milk",
      displayName: "2L",
      singlePrice: { price: 860, promoId: null, comparativePrice: null },
      price: 860,
    };
    const result = toPriceObservation(product, store);
    assert.equal(result.product.name, "Anchor Blue Milk 2L");
  });

  it("respects options.observedAt", () => {
    const product = {
      productId: "5004821-EA-000",
      name: "Anchor Blue Milk",
      displayName: "2L",
      singlePrice: { price: 860, promoId: null, comparativePrice: null },
      price: 860,
    };
    const result = toPriceObservation(product, store, { observedAt: "2026-07-17T12:00:00.000Z" });
    assert.equal(result.observedAt, "2026-07-17T12:00:00.000Z");
  });

});