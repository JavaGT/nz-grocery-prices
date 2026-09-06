import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WarehouseClient, parseWarehouseProducts, toWarehouseObservation } from "../../src/adapters/warehouse.js";

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

  it("leaves out-of-range character references verbatim instead of dropping the tile", () => {
    // decodeHtml would throw RangeError pre-hardening; the tile would then be
    // silently swallowed by the JSON.parse try/catch (payload) or crash the
    // whole parse (path/image decode).
    const html = `<div class="product-tile" data-gtm-product="{&quot;id&quot;:&quot;99&quot;,&quot;name&quot;:&quot;Hostile &#1114112; item&quot;,&quot;price&quot;:1.5}">
      <a href="/p/hostile&#x110000;/99" class="embed-responsive item-link"><img class="tile-image" src="https://example.com/i.jpg"></a>
    </div>`;
    const result = parseWarehouseProducts(html);
    assert.equal(result.length, 1);
    assert.equal(result[0].name, "Hostile &#1114112; item");
    assert.equal(result[0].path, "/p/hostile&#x110000;/99");
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

describe("WarehouseClient curl transport", () => {

  it("passes array-form argv with timeout and maxBuffer caps to execFile", async () => {
    const calls = [];
    const client = new WarehouseClient({
      transport: "curl",
      execFile: async (file, args, opts) => {
        calls.push({ file, args, opts });
        return { stdout: "<html>grid</html>" };
      },
    });
    const html = await client.searchProducts({ query: "milk" });
    assert.equal(html, "<html>grid</html>");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, "curl");
    assert.ok(Array.isArray(calls[0].args));
    // URL is one unbroken final argv element (never a shell string).
    assert.ok(calls[0].args.at(-1).includes("/search/updategrid"));
    assert.ok(calls[0].args.at(-2).startsWith("referer: "));
    assert.equal(calls[0].opts.timeout, 45_000);
    assert.equal(calls[0].opts.maxBuffer, 20 * 1024 * 1024);
    assert.equal(calls[0].opts.encoding, "utf8");
  });

  it("caps stderr/stdout flooding when the curl execFile call rejects", async () => {
    const client = new WarehouseClient({
      transport: "curl",
      execFile: async () => {
        const error = new Error("Command failed: curl --silent --show-error …");
        error.code = 22;
        error.stderr = `curl: (22) The requested URL returned error: 403 ${"blocked ".repeat(500)}`;
        error.stdout = "";
        throw error;
      },
    });
    await assert.rejects(client.searchProducts({ query: "milk" }), (error) => {
      assert.match(error.message, /curl request failed \(\/search\/updategrid\) \[exit 22\]/);
      assert.match(error.message, /curl: \(22\) The requested URL returned error: 403/);
      assert.ok(error.message.length < 600, `error message too long: ${error.message.length}`);
      return true;
    });
  });

});