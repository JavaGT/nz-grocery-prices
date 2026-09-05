import assert from "node:assert/strict";
import { test } from "node:test";
import { toCents, minorUnitsToCents, promotionFor, buildObservation } from "../../retailers/_lib/observation.js";
import { parseObservation } from "../../src/domain/observation.js";

test("toCents parses display prices and rejects junk", () => {
  assert.equal(toCents(3.5), 350);
  assert.equal(toCents("$3.50"), 350);
  assert.equal(toCents("1,299.00"), 129900);
  assert.equal(toCents("29.9"), 2990);
  assert.equal(toCents(""), undefined);
  assert.equal(toCents("free"), undefined);
  assert.equal(toCents(undefined), undefined);
  assert.equal(toCents(-3.5), -350);
});

test("minorUnitsToCents scales store-API minor units", () => {
  assert.equal(minorUnitsToCents("2900"), 2900);
  assert.equal(minorUnitsToCents("2900", 2), 2900);
  assert.equal(minorUnitsToCents(290, 1), 2900);
  assert.equal(minorUnitsToCents("abc"), undefined);
  assert.equal(minorUnitsToCents("29.5"), undefined);
});

test("promotionFor derives savings only on genuine discounts", () => {
  assert.equal(promotionFor({ regularCents: 500, currentCents: 500 }), undefined);
  assert.equal(promotionFor({ regularCents: 400, currentCents: 500 }), undefined);
  const promo = promotionFor({ regularCents: 400, currentCents: 300, description: "Save now" });
  assert.deepEqual(promo, {
    type: "SPECIAL",
    memberOnly: false,
    saveCents: 100,
    savePercent: 25,
    description: "Save now",
  });
});

test("buildObservation emits a canonical observation or undefined", () => {
  const observation = buildObservation({
    slug: "example",
    storeId: "online",
    storeName: "Example Online",
    origin: "https://www.example.co.nz",
    retailerProductId: "42",
    url: "https://www.example.co.nz/products/42",
    name: "Widget",
    brand: "Acme",
    regularCents: 1000,
    promoCents: 800,
  });
  parseObservation(observation);
  assert.equal(observation.product.id, "example:42");
  assert.equal(observation.price.promoCents, 800);
  assert.equal(observation.promotion.savePercent, 20);
  assert.equal(observation.store.id, "example:online");

  for (const missing of [
    { retailerProductId: "42", name: "x", regularCents: 1 },
    { slug: "example", name: "x", regularCents: 1 },
    { slug: "example", retailerProductId: "42", regularCents: 1 },
    { slug: "example", retailerProductId: "42", name: "x" },
    { slug: "example", retailerProductId: "42", name: "x", regularCents: 12.5 },
    { slug: "example", retailerProductId: "42", name: "x", regularCents: -5 },
  ]) {
    assert.equal(buildObservation(missing), undefined, JSON.stringify(missing));
  }
});
