import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseSfccGrid,
  toSfccObservations,
  SfccUpdateGridClient,
} from "../../retailers/_lib/sfcc-updategrid.js";
import { toSfccObservation } from "../../src/adapters/warehouse.js";
import { parseObservation } from "../../src/domain/observation.js";

const TILE = `<div class="product-tile" data-pid="N244629" data-gtm-product="{&quot;name&quot;:&quot;Russell Hobbs Satisfry Air Fryer 5.5L&quot;,&quot;id&quot;:&quot;N244629&quot;,&quot;brand&quot;:&quot;Russell Hobbs&quot;,&quot;productEAN&quot;:&quot;9322219033237&quot;,&quot;productBadges&quot;:&quot;badge-hot-price&quot;,&quot;promotionCallOutMessage&quot;:&quot;na&quot;,&quot;category&quot;:&quot;appliances/airfryers&quot;,&quot;price&quot;:89.00,&quot;productThenPrice&quot;:89.00}">
  <a href="/p/russell-hobbs-air-fryer/N244629.html" class="thumb-link">
    <img src="https://img.example/n244629.jpg">
  </a>
  <a href="/p/russell-hobbs-air-fryer/N244629.html" class="link embed-responsive p-a">
  </a>
  <div>1 – 24 of 96 products</div>
</div>`;

test("parseSfccGrid reuses the warehouse tile parser", () => {
  const products = parseSfccGrid(TILE);
  assert.equal(products.length, 1);
  assert.equal(products[0].name, "Russell Hobbs Satisfry Air Fryer 5.5L");
});

test("toSfccObservation keys identity off store.retailer", () => {
  const [product] = parseSfccGrid(TILE);
  const observation = toSfccObservation(product, {
    id: "noel-leeming:online",
    retailer: "noel-leeming",
    name: "Noel Leeming Online",
  }, { observedAt: "2026-09-06T00:00:00.000Z" });
  parseObservation(observation);
  assert.equal(observation.product.id, "noel-leeming:N244629");
  assert.equal(observation.store.retailer, "noel-leeming");
  assert.equal(observation.source.adapter, "noel-leeming");
  assert.equal(observation.price.regularCents, 8900);
  assert.equal(observation.product.gtin, "9322219033237");
});

test("toSfccObservations maps the grid with origin-resolved urls", () => {
  const store = { id: "nl:online", retailer: "noel-leeming", name: "NL", origin: "https://www.noelleeming.co.nz" };
  const observations = toSfccObservations(parseSfccGrid(TILE), store);
  assert.equal(observations[0].source.url, "https://www.noelleeming.co.nz/p/russell-hobbs-air-fryer/N244629.html");
});

test("SfccUpdateGridClient walks categories by offset and stops on no-fresh pages", async () => {
  const gridFor = (id, total) =>
    TILE.replaceAll("N244629", id).replaceAll("Russell Hobbs Satisfry Air Fryer 5.5L", `Item ${id}`).replaceAll("96", String(total));
  const pages = {};
  for (const cgid of ["appliances", "gaming"]) {
    pages[cgid] = [gridFor(`${cgid}-a`, 144), gridFor(`${cgid}-b`, 144), gridFor(`${cgid}-a`, 144)];
  }
  const client = new SfccUpdateGridClient({
    slug: "nlexample",
    origin: "https://nlexample.co.nz",
    categories: ["appliances", "gaming"],
    transport: "fetch",
    fetch: async (url) => {
      const params = new URL(url).searchParams;
      const cgid = params.get("cgid");
      const start = Number(params.get("start"));
      const page = pages[cgid][start / 48];
      if (!page) throw new Error(`unexpected ${url}`);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => undefined },
        body: {},
        text: async () => page,
      };
    },
  });
  const observations = await client.collectProducts({ observedAt: "2026-09-06T00:00:00.000Z" });
  // each category: page1 fresh, page2 fresh, page3 all-duplicates -> stop
  assert.equal(observations.length, 4);
  for (const observation of observations) parseObservation(observation);
  assert.ok(observations.some((o) => o.product.id === "nlexample:appliances-a"));
  assert.ok(observations.some((o) => o.product.id === "nlexample:gaming-b"));
});
