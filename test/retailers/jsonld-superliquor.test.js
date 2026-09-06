import assert from "node:assert/strict";
import { test } from "node:test";
import { jsonLdProductSpec, parseJsonLdProducts } from "../../retailers/_lib/jsonld-pdp.js";
import { mapHit } from "../../retailers/super-liquor/index.js";

test("jsonLdProductSpec reads offer arrays, AggregateOffer lowPrice, and string prices", () => {
  const array = jsonLdProductSpec({
    name: "Array Offer",
    brand: "Acme",
    offers: [
      { price: "9.99" },
      { price: "7.50", highPrice: "10.00" },
    ],
  });
  assert.equal(array.regularCents, 1000);
  assert.equal(array.promoCents, 750);

  const aggregate = jsonLdProductSpec({
    name: "Agg Offer",
    offers: { "@type": "AggregateOffer", lowPrice: "5.14", highPrice: "6.00" },
  });
  assert.equal(aggregate.regularCents, 600);
  assert.equal(aggregate.promoCents, 514);
});

test("parseJsonLdProducts tolerates a single-object @graph without throwing", () => {
  const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":{"@type":"Product","name":"G","offers":{"price":"3.00"}}}</script>`;
  const products = parseJsonLdProducts(html);
  assert.equal(products.length, 1);
  assert.equal(products[0].name, "G");
});

test("parseJsonLdProducts treats non-string input as no products", () => {
  assert.deepEqual(parseJsonLdProducts(undefined), []);
  assert.deepEqual(parseJsonLdProducts(null), []);
});

test("super-liquor mapHit puts the was-price in regular and the current price in promo", () => {
  const spec = mapHit({
    Id: 4242,
    Name: "Sample Bourbon 1L",
    SeName: "sample-bourbon-1l",
    Sku: "9412345678901",
    ProductPrice: { PriceValue: 12.99, OldPriceValue: 14.99 },
  });
  assert.equal(spec.regularCents, 1499);
  assert.equal(spec.promoCents, 1299);

  const plain = mapHit({
    Id: 4243,
    Name: "Plain Vodka 1L",
    ProductPrice: { PriceValue: 20.0, OldPriceValue: null },
  });
  assert.equal(plain.regularCents, 2000);
  assert.equal(plain.promoCents, undefined);
});
