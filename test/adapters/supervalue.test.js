import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseSuperValueStoreLinks,
  parseSuperValueProducts,
  SuperValueClient,
  toSuperValueObservation,
} from "../../src/adapters/supervalue.js";

const talkerHtml = `<div class="talker special talker--Special" data-talker id="line_67890">
  <a href="/product/tasty-cheese-1kg"><figure><img src="https://example.com/cheese.jpg"></figure></a>
  <div class="talker__name  " title="Mainland Tasty Cheese 1kg"><span class="talker__product-name">Mainland Tasty Cheese 1kg</span></div>
  <strong class="price__sell">$ 14.99</strong>
  <span class="talker__prices__was">$ 18.49</span>
  <span class="price__units">ea</span>
</div>`;

const multipageHtml = `
<div class="MultiPage MultiPage__StoreList" data-chooser-page="FindStores-South Island">
<ul class="StoreChooser__List">
<li class="StoreChooser__List__Item">
<a class="StoreLink StoreLink--Default" href="/5e75aaa26d8e6910a300272c/i_choose_you"><svg class="StoreLink__Icon"><use xlink:href="#chooser-store-icon"></use></svg>
<span class="StoreLink__Name">Milton</span>
<span class="StoreLink__Details">
59 Union Street
<br>
Milton 9220
<br>
<span class="StoreLink__Tagline StoreLink__Tagline--Address">Delivers to Milton Surrounds, Balclutha, Lawrence &amp; Mosgiel</span>
<strong>Click &amp; Collect • Delivery • In-store shopping</strong>
</span>
<span class="StoreLink__Select"><span>Select</span></span>
</a>
</li>
</ul>
</div>
<div class="MultiPage MultiPage__StoreList" data-chooser-page="FindStores-North Island">
<ul class="StoreChooser__List">
<li class="StoreChooser__List__Item">
<a class="StoreLink StoreLink--Default" href="/6137db19d74776067b095d71/i_choose_you"><svg class="StoreLink__Icon"><use xlink:href="#chooser-store-icon"></use></svg>
<span class="StoreLink__Name">Mangawhai</span>
<span class="StoreLink__Details">
43 Moir Street
<br>
Mangawhai 0505
<br>
<strong>In-store shopping</strong>
</span>
</a>
</li>
<li class="StoreChooser__List__Item">
<a class="StoreLink StoreLink--Default" href="/5e75aaa26d8e6910a300272c/i_choose_you">
<span class="StoreLink__Name">Milton</span>
<span class="StoreLink__Details">59 Union Street<br>Milton 9220</span>
</a>
</li>
</ul>
</div>
`;

describe("parseSuperValueStoreLinks", () => {
  it("parses chooser links and dedupes repeated stores", () => {
    const stores = parseSuperValueStoreLinks(multipageHtml);
    assert.equal(stores.length, 2);
    const milton = stores.find((s) => s.chooserId === "5e75aaa26d8e6910a300272c");
    assert.ok(milton);
    assert.equal(milton.name, "SuperValue Milton");
    assert.equal(milton.address, "59 Union Street, Milton 9220");
    const mangawhai = stores.find((s) => s.chooserId === "6137db19d74776067b095d71");
    assert.equal(mangawhai.name, "SuperValue Mangawhai");
    assert.equal(mangawhai.address, "43 Moir Street, Mangawhai 0505");
  });

  it("returns empty array for HTML with no store links", () => {
    assert.deepEqual(parseSuperValueStoreLinks("<html></html>"), []);
  });
});

describe("parseSuperValueProducts", () => {
  it("parses myfoodlink talker markup", () => {
    const result = parseSuperValueProducts(talkerHtml);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "67890");
    assert.equal(result[0].sellCents, 1499);
    assert.equal(result[0].wasCents, 1849);
    assert.equal(result[0].isSpecial, true);
  });
});

describe("toSuperValueObservation", () => {
  it("namespaces product, store, and promotion as supervalue", () => {
    const [product] = parseSuperValueProducts(talkerHtml);
    const observation = toSuperValueObservation(
      product,
      { id: "supervalue:milton", name: "SuperValue Milton" },
      { origin: "https://milton.store.supervalue.co.nz" },
    );
    assert.equal(observation.product.id, "supervalue:67890");
    assert.equal(observation.store.retailer, "supervalue");
    assert.equal(observation.price.regularCents, 1849);
    assert.equal(observation.price.promoCents, 1499);
    assert.equal(observation.promotion.type, "SPECIAL");
    assert.equal(observation.promotion.saveCents, 350);
    assert.equal(
      observation.source.url,
      "https://milton.store.supervalue.co.nz/product/tasty-cheese-1kg",
    );
  });
});

describe("SuperValueClient", () => {
  it("lists stores by resolving i_choose_you redirects", async () => {
    const calls = [];
    const fetch = async (url, options = {}) => {
      calls.push({ url: String(url), redirect: options.redirect });
      const path = String(url);
      if (path === "https://store.supervalue.co.nz/multipage") {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: () => null },
          text: async () => multipageHtml,
        };
      }
      if (path.endsWith("/i_choose_you")) {
        const slug = path.includes("5e75aaa26d8e6910a300272c") ? "milton" : "mangawhai";
        return {
          ok: false,
          status: 302,
          statusText: "Found",
          headers: {
            get: (name) =>
              name === "location"
                ? `https://${slug}.store.supervalue.co.nz/`
                : null,
          },
          text: async () => "",
        };
      }
      throw new Error(`unexpected url ${url}`);
    };

    const client = new SuperValueClient({ fetch, retry: false });
    const stores = await client.listStores();
    assert.equal(stores.length, 2);
    const milton = stores.find((s) => s.slug === "milton");
    assert.equal(milton.id, "supervalue:milton");
    assert.equal(milton.origin, "https://milton.store.supervalue.co.nz");
    assert.equal(milton.name, "SuperValue Milton");
    const chooseCalls = calls.filter((c) => c.url.endsWith("/i_choose_you"));
    assert.equal(chooseCalls.length, 2);
    assert.ok(chooseCalls.every((c) => c.redirect === "manual"));
  });

  it("collects specials into supervalue observations", async () => {
    const fetch = async (url) => {
      const parsed = new URL(String(url));
      assert.equal(parsed.origin, "https://milton.store.supervalue.co.nz");
      assert.equal(parsed.pathname, "/specials");
      assert.equal(parsed.searchParams.get("q[]"), "special:1");
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        text: async () => talkerHtml,
      };
    };
    const client = new SuperValueClient({
      origin: "https://milton.store.supervalue.co.nz",
      fetch,
      retry: false,
    });
    const observations = await client.collectDeals({ maxPages: 1 });
    assert.equal(observations.length, 1);
    assert.equal(observations[0].product.id, "supervalue:67890");
    assert.equal(observations[0].store.id, "supervalue:milton");
    assert.equal(observations[0].price.promoCents, 1499);
  });

  it("derives store identity from the origin", () => {
    const client = new SuperValueClient({
      origin: "https://tekuiti.store.supervalue.co.nz",
    });
    const store = client.getStore();
    assert.equal(store.id, "supervalue:tekuiti");
    assert.equal(store.name, "SuperValue Tekuiti");
  });
});
