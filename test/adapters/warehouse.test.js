import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWarehouseProducts, toWarehouseObservation } from "../../src/adapters/warehouse.js";

const warehouseHtml = `<div class="product-tile" data-gtm-product="{&quot;id&quot;:&quot;123456&quot;,&quot;name&quot;:&quot;Anchor Milk 2L&quot;,&quot;brand&quot;:&quot;Anchor&quot;,&quot;price&quot;:5.99,&quot;productThenPrice&quot;:7.99,&quot;productEAN&quot;:&quot;94171006&quot;,&quot;category&quot;:&quot;Dairy&quot;}">
  <a href="/p/anchor-milk-2l/123456" class="embed-responsive item-link"><img class="tile-image" src="https://example.com/milk.jpg"></a>
</div>`;

const multibuyHtml = `<div class="product-tile" data-gtm-product="{&quot;id&quot;:&quot;123456&quot;,&quot;name&quot;:&quot;Anchor Milk 2L&quot;,&quot;brand&quot;:&quot;Anchor&quot;,&quot;price&quot;:5.99,&quot;productThenPrice&quot;:null,&quot;productEAN&quot;:&quot;94171006&quot;,&quot;category&quot;:&quot;Dairy&quot;,&quot;promotionCallOutMessage&quot;:&quot;2 for $5.00&quot;}">
  <a href="/p/anchor-milk-2l/123456" class="embed-responsive item-link"><img class="tile-image" src="https://example.com/milk.jpg"></a>
</div>`;

const noTilesHtml = "<html><body></body></html>";

const malformedHtml = `<div class="product-tile" data-gtm-product="{invalid json">
  <a href="/p/test" class="embed-responsive"><img class="tile-image" src="https://example.com/img.jpg"></a>
</div>`;

const store = { id: "national", name: "The Warehouse Online" };

describe("parseWarehouseProducts", () => {

  it("parses a product from HTML", () => {
    const result = parseWarehouseProducts(warehouseHtml);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "123456");
    assert.equal(result[0].name, "Anchor Milk 2L");
    assert.equal(result[0].price, 5.99);
  });

  it("extracts path and image", () => {
    const result = parseWarehouseProducts(warehouseHtml);
    assert.equal(result[0].path, "/p/anchor-milk-2l/123456");
    assert.ok(result[0].image.startsWith("https://"));
  });

  it("returns empty array for HTML with no product tiles", () => {
    const result = parseWarehouseProducts(noTilesHtml);
    assert.deepEqual(result, []);
  });

  it("skips malformed data-gtm-product JSON", () => {
    const result = parseWarehouseProducts(malformedHtml);
    assert.deepEqual(result, []);
  });

});

describe("toWarehouseObservation", () => {

  it("produces a valid observation", () => {
    const products = parseWarehouseProducts(warehouseHtml);
    const result = toWarehouseObservation(products[0], store);
    assert.equal(result.product.id, "warehouse:123456");
    assert.equal(result.product.name, "Anchor Milk 2L");
    assert.equal(result.product.brand, "Anchor");
    assert.equal(result.product.gtin, "94171006");
    assert.deepEqual(result.product.categories, ["Dairy"]);
    assert.equal(result.price.regularCents, 799);
    assert.equal(result.price.promoCents, 599);
    assert.equal(result.store.retailer, "warehouse");
    assert.equal(result.promotion.type, "SPECIAL");
  });

  it("returns undefined when id is missing", () => {
    const result = toWarehouseObservation({ name: "Test", price: 5.99 }, store);
    assert.equal(result, undefined);
  });

  it("returns undefined when price is missing", () => {
    const result = toWarehouseObservation({ id: "123456", name: "Test" }, store);
    assert.equal(result, undefined);
  });

  it("handles multibuy promotion callout", () => {
    const products = parseWarehouseProducts(multibuyHtml);
    const result = toWarehouseObservation(products[0], store);
    assert.equal(result.promotion.type, "MULTIBUY");
    assert.equal(result.promotion.threshold, 2);
    assert.equal(result.promotion.totalCents, 500);
    assert.equal(result.price.promoCents, 250);
  });

  it("respects options.observedAt", () => {
    const products = parseWarehouseProducts(warehouseHtml);
    const result = toWarehouseObservation(products[0], store, { observedAt: "2026-07-17T12:00:00.000Z" });
    assert.equal(result.observedAt, "2026-07-17T12:00:00.000Z");
  });

});