import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeEntities,
  extractTileSlices,
  parseMagentoTile,
  parseMagentoTiles,
  MagentoListClient,
} from "../../retailers/_lib/magento-html.js";
import { parseObservation } from "../../src/domain/observation.js";

/** Mirrors the Hunting & Fishing tile profile (retailers/hunting-fishing). */
const HF_PROFILE = {
  tileStart: /<li[^>]*class="[^"]*\bproduct-item\b[^"]*"/g,
  id: [/data-product-id="(\d+)"/],
  name: [/class="product-item-link__name[^"]*">\s*([^<]+?)\s*</],
  linkClass: "product-item-link",
  finalPrice: [
    /data-price-type="finalPrice"[^>]*data-price-amount="([\d.]+)"/,
    /data-price-amount="([\d.]+)"[^>]*data-price-type="finalPrice"/,
  ],
  wasPrice: [
    /data-price-type="oldPrice"[^>]*data-price-amount="([\d.]+)"/,
    /data-price-amount="([\d.]+)"[^>]*data-price-type="oldPrice"/,
  ],
  image: true,
};

/** Mirrors the Animates tile profile: meta-tag SKU and price. */
const ANIMATES_PROFILE = {
  tileStart: /<li[^>]*class="[^"]*\bproduct product-item\b[^"]*"/g,
  id: [/Product SKU\s*-->\s*<meta\s+content="([^"]+)"/],
  name: [/<span class="product-name"\s*>\s*([^<]+?)\s*</],
  linkClass: "product-item-link",
  finalPrice: [
    /<div class="price-box"\s*>\s*<meta\s+content="[^"]*"\s*\/>\s*<meta\s+content="([\d.]+)"/,
  ],
  wasPrice: [],
};

const HF_TILE = `<li class="product-item">
  <a title="Hunters Element Apex Bino Defender" href="https://hf.example/apex-99352690" class="product-item-link">
    <img src="https://hf.example/media/catalog/product/apex.jpg" alt="x">
    <span class="product-item-link__name main"> Hunters Element Apex Bino Defender </span>
  </a>
  <div class="price-box price-final_price" data-role="priceBox" data-product-id="727671">
    <span class="special-price"><span data-price-amount="149.99" data-price-type="finalPrice" class="price-wrapper"><span class="price">$149.99</span></span></span>
    <span class="old-price"><span data-price-amount="229.99" data-price-type="oldPrice" class="price-wrapper"><span class="price">$229.99</span></span></span>
  </div>
</li>`;

const ANIMATES_TILE = `<li class="item product product-item" >
  <div class="product-item-info" >
    <a href="https://ani.example/slicker.html"
       class="product-item-link" >
      <img src="https://ani.example/media/catalog/product/ba510_1.jpg" alt="Yours&#x20;Droolly&#x20;Slicker">
      <span class="product-name" >
        Yours Droolly Slicker
      </span>
    </a>
    <!-- Product SKU -->
    <meta  content="I154007" />
    <!-- Product Price -->
    <div class="price-box"  >
      <meta  content="NZD" />
      <meta  content="37.99" />
      <span class="price">$37.99</span>
    </div>
  </div>
</li>`;

test("decodeEntities handles numeric and named entities", () => {
  assert.equal(decodeEntities("Yours&#x20;Droolly"), "Yours Droolly");
  assert.equal(decodeEntities("&amp;&quot;&#39;"), "&\"'");
});

test("H&F profile extracts sale pricing into regular+promo", () => {
  const tiles = parseMagentoTiles(`<div>${HF_TILE}</div>`, HF_PROFILE);
  assert.equal(tiles.length, 1);
  const tile = tiles[0];
  assert.equal(tile.id, "727671");
  assert.equal(tile.name, "Hunters Element Apex Bino Defender");
  assert.equal(tile.url, "https://hf.example/apex-99352690");
  assert.equal(tile.regularCents, 22999);
  assert.equal(tile.promoCents, 14999);
  assert.equal(tile.image, "https://hf.example/media/catalog/product/apex.jpg");
});

test("Animates profile reads SKU ids and meta-tag prices", () => {
  const tiles = parseMagentoTiles(`<div>${ANIMATES_TILE}</div>`, ANIMATES_PROFILE);
  assert.equal(tiles.length, 1);
  const tile = tiles[0];
  assert.equal(tile.id, "I154007");
  assert.equal(tile.name, "Yours Droolly Slicker");
  assert.equal(tile.regularCents, 3799);
  assert.equal(tile.promoCents, undefined);
});

test("parseMagentoTile drops tiles missing identity, name, or price", () => {
  assert.equal(parseMagentoTile("<li>no data</li>", HF_PROFILE), undefined);
  assert.equal(parseMagentoTile(HF_TILE.replace(/data-price-amount="[\d.]+"/g, 'data-price-amount=""'), HF_PROFILE), undefined);
});

test("MagentoListClient walks categories, stops on no-new-tiles, emits valid observations", async () => {
  const pages = {
    "/hunting?p=1": HF_TILE + HF_TILE.replace(/727671/g, "727672"),
    "/hunting?p=2": HF_TILE.replace(/727671/g, "727672"), // all duplicates -> stop
    "/fishing?p=1": HF_TILE.replace(/727671/g, "727673"),
    "/fishing?p=2": "<div>no tiles</div>", // empty page -> stop
  };
  const client = new MagentoListClient({
    slug: "hfexample",
    origin: "https://hf.example",
    categories: ["hunting", "fishing"],
    profile: HF_PROFILE,
    fetch: async (url) => {
      const path = new URL(url).pathname + "?" + new URL(url).searchParams.toString();
      const html = pages[path];
      if (!html) throw new Error(`unexpected fetch: ${path}`);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => undefined },
        body: { getReader: undefined },
        text: async () => html,
      };
    },
  });
  const observations = await client.collectProducts({ observedAt: "2026-09-06T00:00:00.000Z" });
  assert.equal(observations.length, 3);
  for (const observation of observations) parseObservation(observation);
  const byCategory = Object.fromEntries(observations.map((o) => [o.product.id, o.product.categories]));
  assert.deepEqual(byCategory["hfexample:727671"], ["hunting"]);
  assert.deepEqual(byCategory["hfexample:727673"], ["fishing"]);
  const sale = observations.find((o) => o.product.id === "hfexample:727671");
  assert.equal(sale.price.regularCents, 22999);
  assert.equal(sale.price.promoCents, 14999);
  assert.equal(sale.promotion.savePercent, 34.78);
});
