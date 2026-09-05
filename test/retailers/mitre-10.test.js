import assert from "node:assert/strict";
import { test } from "node:test";
import { mapDetail, parseShardProductUrls } from "../../retailers/mitre-10/index.js";
import { parseObservation } from "../../src/domain/observation.js";

test("parseShardProductUrls extracts /p/<code> URLs from sitemap XML", () => {
  const xml = `<urlset><url><loc>https://www.mitre10.co.nz/shop/kumho-sinkers-6oz/p/52375</loc></url>
  <url><loc>https://www.mitre10.co.nz/medias/sys_master/root/some-content</loc></url>
  <url><loc>https://www.mitre10.co.nz/shop/senma-line/p/52229</loc></url></urlset>`;
  assert.deepEqual(parseShardProductUrls(xml), [
    "https://www.mitre10.co.nz/shop/kumho-sinkers-6oz/p/52375",
    "https://www.mitre10.co.nz/shop/senma-line/p/52229",
  ]);
});

test("mapDetail maps OCC detail with promo and brand", () => {
  const observation = mapDetail({
    code: "52375",
    name: "Sinkers",
    brandName: "Kumho",
    price: { currencyIso: "NZD", value: 6.98 },
    regularPrice: { currencyIso: "NZD", value: 9.98 },
    canonicalUrl: "/shop/kumho-sinkers-6oz/p/52375",
    images: [{ url: "/medias/sys_master/productimages/x/y/img.jpg" }],
  });
  parseObservation(observation);
  assert.equal(observation.product.id, "mitre-10:52375");
  assert.equal(observation.product.brand, "Kumho");
  assert.equal(observation.price.regularCents, 998);
  assert.equal(observation.price.promoCents, 698);
  assert.equal(observation.source.url, "https://www.mitre10.co.nz/shop/kumho-sinkers-6oz/p/52375");
  assert.equal(observation.product.images.primary, "https://ccapi.mitre10.co.nz/medias/sys_master/productimages/x/y/img.jpg");
});

test("mapDetail falls back to price as regular and drops junk", () => {
  const plain = mapDetail({
    code: "1",
    name: "Widget",
    price: { currencyIso: "NZD", value: 10 },
    regularPrice: { currencyIso: "NZD", value: 10 },
  });
  assert.equal(plain.regularCents, 1000);
  assert.equal(plain.promoCents, undefined);
  assert.equal(mapDetail({ code: "1", name: "X", price: null }), undefined);
  assert.equal(mapDetail({ code: "1", price: { value: 5 } }), undefined);
});
