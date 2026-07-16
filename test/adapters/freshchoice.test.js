import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseFreshChoiceProducts, toFreshChoiceObservation } from "../../src/adapters/freshchoice.js";

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