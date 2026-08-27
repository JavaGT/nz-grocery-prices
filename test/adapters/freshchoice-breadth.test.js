import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseSitemapCategoryUrls,
  BREAKER_THRESHOLD,
  FreshChoiceBreadthClient,
} from "../../src/adapters/freshchoice-breadth.js";

// ---- sitemap parser -------------------------------------------------------

describe("parseSitemapCategoryUrls", () => {
  it("extracts /category/* URLs from sitemap XML", () => {
    const xml = `<?xml version="1.0"?>
<urlset>
  <url><loc>https://qt.store.fc.co.nz/category/bakery</loc></url>
  <url><loc>https://qt.store.fc.co.nz/category/bread</loc></url>
  <url><loc>https://qt.store.fc.co.nz/lines/some-product</loc></url>
</urlset>`;
    const result = parseSitemapCategoryUrls(xml);
    assert.deepEqual(result, [
      "https://qt.store.fc.co.nz/category/bakery",
      "https://qt.store.fc.co.nz/category/bread",
    ]);
  });

  it("skips /lines PDP URLs and only returns /category/ URLs", () => {
    const xml = `<?xml version="1.0"?>
<urlset>
  <url><loc>https://qt.store.fc.co.nz/lines/milk</loc></url>
  <url><loc>https://qt.store.fc.co.nz/lines/bread</loc></url>
</urlset>`;
    const result = parseSitemapCategoryUrls(xml);
    assert.deepEqual(result, []);
  });

  it("deduplicates identical URLs", () => {
    const xml = `<?xml version="1.0"?>
<urlset>
  <url><loc>https://qt.store.fc.co.nz/category/bakery</loc></url>
  <url><loc>https://qt.store.fc.co.nz/category/bakery</loc></url>
</urlset>`;
    const result = parseSitemapCategoryUrls(xml);
    assert.deepEqual(result, ["https://qt.store.fc.co.nz/category/bakery"]);
  });

  it("returns sorted URLs", () => {
    const xml = `<?xml version="1.0"?>
<urlset>
  <url><loc>https://qt.store.fc.co.nz/category/bread</loc></url>
  <url><loc>https://qt.store.fc.co.nz/category/bakery</loc></url>
</urlset>`;
    const result = parseSitemapCategoryUrls(xml);
    assert.deepEqual(result, [
      "https://qt.store.fc.co.nz/category/bakery",
      "https://qt.store.fc.co.nz/category/bread",
    ]);
  });

  it("returns empty array for non-string input", () => {
    assert.deepEqual(parseSitemapCategoryUrls(null), []);
    assert.deepEqual(parseSitemapCategoryUrls(undefined), []);
    assert.deepEqual(parseSitemapCategoryUrls(""), []);
  });

  it("returns empty array for XML with no /category/ entries", () => {
    const xml = `<?xml version="1.0"?><urlset></urlset>`;
    assert.deepEqual(parseSitemapCategoryUrls(xml), []);
  });
});

// ---- FreshChoiceBreadthClient ---------------------------------------------

function fakeResponse(ok, status, body) {
  return {
    ok,
    status,
    text: async () => body,
    headers: new Headers(),
  };
}

function sitemapXml(categories) {
  const locs = categories
    .map((cat) => `<url><loc>https://store/category/${cat}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0"?><urlset>${locs}</urlset>`;
}

function categoryHtml(cards) {
  // Simple product card HTML matching what parseFreshChoiceProducts expects
  // Note: parser requires at least one class after "talker" (e.g. "special").
  return cards
    .map(
      (c, i) =>
        `<div class="talker special" data-talker id="line_${c.id}">
          <a href="/product/${c.slug}"><figure><img src="https://img.example.com/${c.id}.jpg"></figure></a>
          <div class="talker__name" title="${c.name}"><span class="talker__product-name">${c.name}</span></div>
          <strong class="price__sell">$ ${(c.sell / 100).toFixed(2)}</strong>
          ${c.was ? `<span class="talker__prices__was">$ ${(c.was / 100).toFixed(2)}</span>` : ""}
          <span class="price__units">ea</span>
        </div>`,
    )
    .join("");
}

const sampleStore = {
  id: "freshchoice:testville",
  slug: "testville",
  name: "FreshChoice Testville",
  origin: "https://testville.store.freshchoice.co.nz",
};

describe("FreshChoiceBreadthClient", () => {
  it("fetches and parses sitemap", async () => {
    const transport = async (url) => {
      assert.match(url, /sitemap\.xml$/);
      return fakeResponse(true, 200, sitemapXml(["bakery", "dairy"]));
    };
    const client = new FreshChoiceBreadthClient({
      fetch: transport,
      delayMs: 0,
    });
    const urls = await client.fetchSitemap("https://testville.store.fc.co.nz");
    assert.equal(urls.length, 2);
    assert.ok(urls[0].includes("/category/bakery"));
    assert.ok(urls[1].includes("/category/dairy"));
    assert.equal(client.consecutiveFailures, 0);
    assert.equal(client.circuitOpened, false);
  });

  it("throws on sitemap fetch failure", async () => {
    const transport = async () =>
      fakeResponse(false, 404, "Not Found");
    const client = new FreshChoiceBreadthClient({
      fetch: transport,
      delayMs: 0,
    });
    await assert.rejects(
      () => client.fetchSitemap("https://testville.store.fc.co.nz"),
      /sitemap fetch failed/,
    );
    assert.equal(client.consecutiveFailures, 1);
  });

  it("fetches category page HTML", async () => {
    const transport = async (url) => {
      assert.match(url, /\/category\/bakery/);
      return fakeResponse(true, 200, categoryHtml([
        { id: "1", slug: "milk", name: "Milk", sell: 599 },
      ]));
    };
    const client = new FreshChoiceBreadthClient({
      fetch: transport,
      delayMs: 0,
    });
    const html = await client.fetchCategoryPage(
      "https://testville.store.fc.co.nz",
      "/category/bakery",
      0,
    );
    assert.ok(html.includes("Milk"));
    assert.equal(client.consecutiveFailures, 0);
  });

  it("affixes ?page=N for non-zero page", async () => {
    let fetchedUrl;
    const transport = async (url) => {
      fetchedUrl = url;
      return fakeResponse(true, 200, categoryHtml([]));
    };
    const client = new FreshChoiceBreadthClient({
      fetch: transport,
      delayMs: 0,
    });
    await client.fetchCategoryPage(
      "https://testville.store.fc.co.nz",
      "/category/bakery",
      2,
    );
    assert.ok(fetchedUrl.endsWith("?page=2"));
  });

  it("throws on category page failure", async () => {
    let callCount = 0;
    const transport = async () => {
      callCount += 1;
      return fakeResponse(false, 500, "Server Error");
    };
    const client = new FreshChoiceBreadthClient({
      fetch: transport,
      delayMs: 0,
    });
    await assert.rejects(
      () =>
        client.fetchCategoryPage(
          "https://testville.store.fc.co.nz",
          "/category/bakery",
          0,
        ),
      /category page fetch failed/,
    );
    assert.equal(client.consecutiveFailures, 1);
  });

  it("opens circuit after BREAKER_THRESHOLD consecutive failures", async () => {
    const transport = async () =>
      fakeResponse(false, 500, "Server Error");
    const client = new FreshChoiceBreadthClient({
      fetch: transport,
      delayMs: 0,
    });
    for (let i = 0; i < BREAKER_THRESHOLD - 1; i += 1) {
      await assert.rejects(
        () =>
          client.fetchCategoryPage(
            "https://store.fc.co.nz",
            "/category/x",
            0,
          ),
        /category page fetch failed/,
      );
    }
    assert.equal(client.circuitOpened, false);
    // One more pushes it over
    await assert.rejects(
      () =>
        client.fetchCategoryPage("https://store.fc.co.nz", "/category/x", 0),
      /category page fetch failed/,
    );
    assert.equal(client.circuitOpened, true);
    assert.equal(client.consecutiveFailures, BREAKER_THRESHOLD);
  });

  it("resets breaker after a success", async () => {
    let fail = true;
    const transport = async () => {
      if (fail) return fakeResponse(false, 500, "Err");
      return fakeResponse(true, 200, categoryHtml([]));
    };
    const client = new FreshChoiceBreadthClient({
      fetch: transport,
      delayMs: 0,
    });
    // One failure
    await assert.rejects(() =>
      client.fetchCategoryPage("https://store.fc.co.nz", "/category/x", 0),
    );
    assert.equal(client.consecutiveFailures, 1);
    // Success resets
    fail = false;
    await client.fetchCategoryPage("https://store.fc.co.nz", "/category/x", 0);
    assert.equal(client.consecutiveFailures, 0);
  });

  it("paces requests when delayMs > 0", async () => {
    const timestamps = [];
    const transport = async () => {
      timestamps.push(Date.now());
      return fakeResponse(true, 200, categoryHtml([]));
    };
    const client = new FreshChoiceBreadthClient({
      fetch: transport,
      delayMs: 50,
    });
    await client.fetchCategoryPage("https://s.fc.co.nz", "/category/a", 0);
    await client.fetchCategoryPage("https://s.fc.co.nz", "/category/b", 0);
    assert.equal(timestamps.length, 2);
    const gap = timestamps[1] - timestamps[0];
    assert.ok(gap >= 40, `expected gap >= 40ms, got ${gap}ms`);
  });
});