#!/usr/bin/env node
/**
 * Parse-CPU bench for the shared retailer-platform transforms
 * (retailers/_lib/*) plus the mapper path into buildObservation.
 *
 * CAVEAT: raw retailer payloads are not archived anywhere in this repo
 * (archives hold canonical records only), so payloads here are
 * synthetic-but-realistic: they mirror the fixture shapes pinned by
 * test/retailers/*.test.js, inflated to page scale (48 items, matching
 * the families' default page sizes). Absolute numbers are indicative;
 * the useful output is µs/item per family and whether parse CPU is
 * material next to network time (it is not — see REPORT-ingest.md).
 *
 * Offline only: no fetchers, no clients, pure functions.
 */

import {
  parseHtmlTiles,
} from "../retailers/_lib/html-grid.js";
import { toShopifyObservations } from "../retailers/_lib/shopify.js";
import { toAlgoliaObservations } from "../retailers/_lib/algolia.js";
import { mapMagentoItem } from "../retailers/_lib/magento-graphql.js";
import { mapWooProduct } from "../retailers/_lib/woocommerce.js";
import { parseWindowJson, parseEstarItems, mapEstarItem } from "../retailers/_lib/estar-category.js";
import { parseNextData, findDehydratedQuery, mapRawItem } from "../retailers/_lib/next-data.js";
import { parseSfccGrid, toSfccObservations } from "../retailers/_lib/sfcc-updategrid.js";
import { parseJsonLdProducts, jsonLdProductSpec } from "../retailers/_lib/jsonld-pdp.js";
import { mapConstructorItem } from "../retailers/_lib/constructor-io.js";

const PAGE = 48;
const REPS = 400;
const OBSERVED_AT = "2026-09-09T00:00:00.000Z";

// ---- payload generators (fixture shapes from test/retailers/*) ----

const HF_PROFILE = {
  tileStart: /<li[^>]*class="[^"]*\bproduct-item\b[^"]*"/g,
  id: [/data-product-id="(\d+)"/],
  name: [/class="product-item-link__name[^"]*">\s*([^<]+?)\s*</],
  linkClass: "product-item-link",
  finalPrice: [/data-price-type="finalPrice"[^>]*data-price-amount="([\d.]+)"/],
  wasPrice: [/data-price-type="oldPrice"[^>]*data-price-amount="([\d.]+)"/],
  image: true,
};

function hfTile(index) {
  return `<li class="product-item">
  <a title="Product Name ${index} 500g" href="https://hf.example/item-${index}" class="product-item-link">
    <img src="https://hf.example/media/catalog/product/item-${index}.jpg" alt="x">
    <span class="product-item-link__name main"> Product Name ${index} 500g </span>
  </a>
  <div class="price-box price-final_price" data-role="priceBox" data-product-id="${index}">
    <span class="special-price"><span data-price-amount="${(9.9 + (index % 40)).toFixed(2)}" data-price-type="finalPrice" class="price-wrapper"><span class="price">$${(9.9 + (index % 40)).toFixed(2)}</span></span></span>
    <span class="old-price"><span data-price-amount="${(19.9 + (index % 40)).toFixed(2)}" data-price-type="oldPrice" class="price-wrapper"><span class="price">$${(19.9 + (index % 40)).toFixed(2)}</span></span></span>
  </div>
</li>`;
}

function shopifyProduct(index) {
  return {
    id: 100000 + index,
    handle: `test-powder-${index}`,
    title: `Test Powder ${index} 500g`,
    vendor: "TestBrand",
    product_type: "Supplements",
    tags: ["vegan", "sale"],
    images: [{ src: `https://cdn.example/powder-${index}.jpg` }],
    variants: [
      {
        id: 900000 + index,
        price: `${(19 + (index % 30))}.90`,
        compare_at_price: index % 3 === 0 ? `${(29 + (index % 30))}.90` : null,
        barcode: `9412345678${String(100 + index)}`,
      },
    ],
  };
}

function algoliaHit(index) {
  return {
    Id: 4242 + index,
    Name: `Sample Bourbon ${index} 1L`,
    SeName: `sample-bourbon-${index}-1l`,
    Sku: `9412345678${String(200 + index)}`,
    ProductPrice: {
      PriceValue: 12.99 + (index % 20),
      OldPriceValue: index % 2 === 0 ? 14.99 + (index % 20) : undefined,
    },
  };
}

function magentoItem(index) {
  return {
    id: 4623650 + index,
    sku: `SP-${index}`,
    name: `2XU Run Belt ${index}`,
    url_key: `2xu-run-belt-${index}`,
    price_range: {
      minimum_price: {
        final_price: { value: 50.99 + (index % 10) },
        regular_price: { value: 59.99 + (index % 10) },
        discount: { amount_off: 9, percent_off: 15 },
      },
    },
    small_image: { url: `https://img.example/belt-${index}.jpg` },
  };
}

function wooProduct(index) {
  return {
    id: 42 + index,
    name: `Test Merlot ${index} 750ml`,
    permalink: `https://woo.example/product/test-merlot-${index}`,
    prices: {
      price: "1999",
      regular_price: "2499",
      sale_price: index % 2 === 0 ? "1999" : "0",
      currency_minor_unit: 2,
    },
    images: [{ src: `https://woo.example/merlot-${index}.jpg` }],
    short_description: "<p>Nice</p>",
  };
}

function estarItem(index) {
  return {
    productid: 125404 + index,
    description: `The People's Rose ${index} 750ml`,
    label: "The People's",
    stylecolour: {
      urlkey: `the-peoples-rose-${index}-750ml-230496`,
      variants: [
        {
          barcode: `23049${index % 10}`,
          currency: "NZD",
          baseunitprice: "14.99",
          unitprice: "12.99",
        },
      ],
    },
    images: [{ src: `https://img.example/rose-${index}.jpg` }],
  };
}

const ESTAR_HTML =
  `<html><body><script>window.category = ${JSON.stringify({
    type: "category",
    categoryid: 5,
    items: Array.from({ length: PAGE }, (_, i) => estarItem(i)),
    pagination: { currentPage: 1, itemsPerPage: PAGE, totalItems: 7304 },
  })};</script></body></html>`;

function nextRaw(index) {
  return {
    code: `043115${index % 10}`,
    name: `100mm Assorted Potted Colour ${index}`,
    brandname: "Greenlife",
    price: 1.8 + (index % 5) / 10,
    currency: "NZD",
    imageurl: `https://img.example/pot-${index}.jpg`,
    productroutingurl: `/100mm-assorted-potted-colour-${index}_p0431151`,
  };
}

const NEXT_HTML = `<html><head><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
  buildId: "bench",
  props: {
    pageProps: {
      dehydratedState: {
        queries: [
          {
            queryKey: ["category-search", "/products/garden/plants", "zone", "store"],
            state: {
              data: {
                results: Object.fromEntries(
                  Array.from({ length: PAGE }, (_, i) => [String(i), { raw: nextRaw(i) }]),
                ),
              },
              totalCount: PAGE,
            },
          },
        ],
      },
    },
  },
})}</script></head></html>`;

function sfccTile(index) {
  const gtm = JSON.stringify({
    name: `Air Fryer ${index} 5.5L`,
    id: `N2446${String(index).padStart(3, "0")}`,
    brand: "Russell Hobbs",
    productEAN: `9322219033${String(100 + index)}`,
    productBadges: "badge-hot-price",
    promotionCallOutMessage: "na",
    category: "appliances/airfryers",
    price: 89.0,
    productThenPrice: 89.0,
  }).replaceAll("&", "&amp;").replaceAll('"', "&quot;");
  return `<div class="product-tile" data-pid="N2446${String(index).padStart(3, "0")}" data-gtm-product="${gtm}">
  <a href="/p/air-fryer-${index}/N2446${String(index).padStart(3, "0")}.html" class="thumb-link">
    <img src="https://img.example/n2446${index}.jpg">
  </a>
  <a href="/p/air-fryer-${index}/N2446${String(index).padStart(3, "0")}.html" class="link embed-responsive p-a">
  </a>
  <div>1 – 24 of 96 products</div>
</div>`;
}

function jsonLdPdpHtml(index) {
  const graph = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "Organization", name: "Store" },
      {
        "@type": "Product",
        name: `Office Thing ${index}`,
        brand: "Acme",
        gtin13: `94005861000${index % 10}`,
        offers: { "@type": "Offer", price: `${12 + (index % 30)}.99`, priceCurrency: "NZD", availability: "https://schema.org/InStock" },
      },
    ],
  };
  return `<html><head><script type="application/ld+json">${JSON.stringify(graph)}</script></head><body>page ${index}</body></html>`;
}

function constructorItem(index) {
  return {
    value: `Sprite ${index} 1.5L`,
    data: { id: `P_4368468${index % 10}`, uri: `/p/4368468${index % 10}`, Brand: "Sprite" },
    variations: [{ data: { price: 3.5 + (index % 9) / 10, apn: `9300675046${String(10 + index)}` } }],
  };
}

// ---- harness ----

function median(a) {
  return [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
}

const SUITES = [
  ["html-grid parseHtmlTiles (48 tiles)", () => {
    const html = Array.from({ length: PAGE }, (_, i) => hfTile(i)).join("\n");
    return () => parseHtmlTiles(html, HF_PROFILE).length;
  }, PAGE],
  ["shopify toShopifyObservations (48 products)", () => {
    const products = Array.from({ length: PAGE }, (_, i) => shopifyProduct(i));
    const store = { id: "shopexample:online", retailer: "shopexample", scopeId: "online", name: "Shop Example", origin: "https://shop.example" };
    return () => products.flatMap((p) => toShopifyObservations(p, store, { observedAt: OBSERVED_AT })).length;
  }, PAGE],
  ["algolia toAlgoliaObservations (48 hits)", () => {
    const hits = Array.from({ length: PAGE }, (_, i) => algoliaHit(i));
    const store = { id: "sl:online", retailer: "super-liquor", scopeId: "online", name: "SL", origin: "https://sl.example" };
    const mapHit = (hit) => ({
      retailerProductId: String(hit.Id),
      url: `${store.origin}/${hit.SeName}`,
      name: hit.Name,
      gtin: hit.Sku,
      regularCents: Math.round(hit.ProductPrice.OldPriceValue * 100),
      promoCents: Math.round(hit.ProductPrice.PriceValue * 100),
      image: undefined,
      brand: undefined,
    });
    return () => toAlgoliaObservations(hits, store, mapHit, { observedAt: OBSERVED_AT }).length;
  }, PAGE],
  ["magento mapMagentoItem (48 items)", () => {
    const items = Array.from({ length: PAGE }, (_, i) => magentoItem(i));
    const store = { retailer: "rsexample", scopeId: "online", name: "RS", origin: "https://rsexample.co.nz" };
    return () => items.map((item) => mapMagentoItem(item, store) !== undefined).length;
  }, PAGE],
  ["woocommerce mapWooProduct (48 products)", () => {
    const items = Array.from({ length: PAGE }, (_, i) => wooProduct(i));
    const store = { id: "wooexample:online", retailer: "wooexample", scopeId: "online", name: "Woo", origin: "https://woo.example" };
    return () => items.map((item) => mapWooProduct(item, store) !== undefined).length;
  }, PAGE],
  ["estar parseWindowJson+items+map (48 items)", () => {
    const store = { retailer: "llexample", scopeId: "online", name: "LL", origin: "https://llexample.co.nz" };
    return () => parseEstarItems(parseWindowJson(ESTAR_HTML)).map((item) => mapEstarItem(item, store) !== undefined).length;
  }, PAGE],
  ["next-data parse+find+mapRawItem (48 items)", () => {
    const store = { retailer: "bnnsexample", scopeId: "online", name: "BN", origin: "https://bn.example" };
    return () => {
      const json = parseNextData(NEXT_HTML);
      const query = findDehydratedQuery(json, "category-search");
      const raws = Object.values(query.state.data.results);
      return raws.map((raw) => mapRawItem(raw.raw, store) !== undefined).length;
    };
  }, PAGE],
  ["sfcc parseSfccGrid+toSfccObservations (48 tiles)", () => {
    const html = Array.from({ length: PAGE }, (_, i) => sfccTile(i)).join("\n");
    const store = { id: "nl:online", retailer: "noel-leeming", name: "NL", origin: "https://www.noelleeming.co.nz" };
    return () => toSfccObservations(parseSfccGrid(html), store, { observedAt: OBSERVED_AT }).length;
  }, PAGE],
  ["jsonld-pdp parse+spec (48 PDPs)", () => {
    const pages = Array.from({ length: PAGE }, (_, i) => jsonLdPdpHtml(i));
    return () => pages
      .map((page) => parseJsonLdProducts(page)[0])
      .filter(Boolean)
      .map((product) => jsonLdProductSpec(product) !== undefined).length;
  }, PAGE],
  ["constructor-io mapConstructorItem (48 items)", () => {
    const items = Array.from({ length: PAGE }, (_, i) => constructorItem(i));
    const store = { retailer: "kmexample", scopeId: "online", name: "KM", origin: "https://km.example" };
    return () => items.map((item) => mapConstructorItem(item, store) !== undefined).length;
  }, PAGE],
];

console.log(`page=${PAGE} items, reps=${REPS} (median per rep)\n`);
for (const [name, make, itemsPerRep] of SUITES) {
  const run = make();
  run(); // warmup / JIT + hidden-class warm
  const samples = [];
  for (let i = 0; i < REPS; i += 1) {
    const start = process.hrtime.bigint();
    run();
    samples.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  const ms = median(samples);
  const usPerItem = (ms * 1000) / itemsPerRep;
  console.log(
    name.padEnd(48),
    `${ms.toFixed(3).padStart(8)} ms/rep`,
    `${usPerItem.toFixed(1).padStart(6)} us/item`,
  );
}
