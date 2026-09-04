import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  taskId,
  categoryKey,
  absorbProducts,
  crawlStore,
  parseArgs,
  runCollection,
  pickCrawlableStore,
  DEFAULT_DELAY_MS,
  DEFAULT_FILE,
  DEFAULT_PILOT_BUDGET,
} from "../scripts/freshchoice-breadth.js";
import { BREAKER_THRESHOLD } from "../src/adapters/freshchoice-breadth.js";
import { assertNotLiveArchive } from "../scripts/lib/breadth-helpers.js";

// ---- fixture helpers -------------------------------------------------------

function product(id, sell = 599, was = undefined) {
  return { id: String(id), name: `Product ${id}`, sellCents: sell, wasCents: was };
}

/** Create page HTML fixture from products. */
function catHtml(products) {
  return products
    .map(
      (p) =>
        `<div class="talker special" data-talker id="line_${p.id}">
          <a href="/lines/${p.id}"><figure><img src="https://img.example.com/${p.id}.jpg"></figure></a>
          <div class="talker__name" title="${p.name}"><span class="talker__product-name">${p.name}</span></div>
          <strong class="price__sell">$ ${(p.sellCents / 100).toFixed(2)}</strong>
          ${p.wasCents != null ? `<span class="talker__prices__was">$ ${(p.wasCents / 100).toFixed(2)}</span>` : ""}
          <span class="price__units">ea</span>
        </div>`,
    )
    .join("");
}

function sitemapXml(categories) {
  const locs = categories
    .map((cat) => `<url><loc>https://store.fc.co.nz/category/${cat}</loc></url>`)
    .join("\n");
  return `<?xml version="1.0"?><urlset>${locs}</urlset>`;
}

/** Build page HTML with page-count aria labels to trigger pageCount(). */
function catHtmlWithPages(products, maxPage) {
  const labels = Array.from({ length: maxPage }, (_, i) =>
    `aria-label="Page ${i + 1}"`,
  ).join(" ");
  return `<div ${labels}>${catHtml(products)}</div>`;
}

const store = {
  id: "freshchoice:testville",
  slug: "testville",
  name: "FreshChoice Testville",
  origin: "https://testville.store.freshchoice.co.nz",
  retailer: "freshchoice",
};

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    text: async () => body,
    headers: new Headers(),
  };
}

// ---- pure helpers ----------------------------------------------------------

describe("planning helpers", () => {
  it("categoryKey builds stable keys from paths", () => {
    assert.equal(categoryKey("/category/bakery"), "cat=bakery");
    assert.equal(categoryKey("/category/bread"), "cat=bread");
  });

  it("taskId builds stable identifiers", () => {
    assert.equal(
      taskId("testville", "/category/bakery", 0),
      "testville:cat=bakery:page0",
    );
    assert.equal(
      taskId("testville", "/category/bakery", 3),
      "testville:cat=bakery:page3",
    );
  });

  it("absorbProducts deduplicates by product.id", () => {
    const seen = new Map();
    const products = [
      product("1", 599),
      product("2", 499),
      product("1", 599), // duplicate
    ];
    const fresh = absorbProducts(seen, products);
    assert.equal(fresh.length, 2);
    assert.equal(seen.size, 2);
    assert.ok(seen.has("1"));
    assert.ok(seen.has("2"));
  });

  it("absorbProducts skips null id", () => {
    const seen = new Map();
    const fresh = absorbProducts(seen, [{ name: "No id", sellCents: 100 }]);
    assert.equal(fresh.length, 0);
  });
});

// ---- crawlStore algorithm --------------------------------------------------

describe("crawlStore (FreshChoice)", () => {
  /**
   * Drive crawlStore against scripted sitemap + category page responses.
   */
  async function drive(sitemapCategories, pageScript, options = {}) {
    const waves = [];
    const client = {
      consecutiveFailures: 0,
      circuitOpened: false,
      fetchSitemap: async (origin) => {
        return sitemapCategories.map(
          (cat) => `${origin.replace(/\/+$/, "")}/category/${cat}`,
        );
      },
      fetchCategoryPage: async (origin, categoryPath, page) => {
        const cat = categoryPath.replace("/category/", "");
        const key = `${cat}:${page}`;
        if (!(key in pageScript)) {
          throw new Error(`unexpected: category=${cat}, page=${page}`);
        }
        const result = pageScript[key];
        if (typeof result === "function") return result();
        return result;
      },
    };
    const result = await crawlStore({
      client,
      store,
      observedAt: "2026-08-27T00:00:00.000Z",
      commitWave: async (observations, continuationIds) => {
        waves.push({ observations, continuationIds });
      },
      collectWarning: () => {},
      ...options,
    });
    return { result, waves };
  }

  it("walks a sitemap with one category and one page", async () => {
    const { result, waves } = await drive(
      ["bakery"],
      {
        "bakery:0": catHtmlWithPages([product("1"), product("2")], 1),
      },
    );
    assert.equal(result.uniqueCount, 2);
    assert.equal(result.pagesFetched, 1);
    assert.deepEqual(result.warnings.filter((w) => !w.includes("seeded")), []);
  });

  it("walks a multi-page category", async () => {
    const { result, waves } = await drive(
      ["bakery"],
      {
        "bakery:0": catHtmlWithPages(
          [product("1"), product("2")],
          3,
        ),
        "bakery:1": catHtmlWithPages(
          [product("3")],
          1,
        ),
        "bakery:2": catHtmlWithPages(
          [product("4")],
          1,
        ),
      },
    );
    assert.equal(result.uniqueCount, 4);
    assert.equal(result.pagesFetched, 3);

    // Continuation pages 1 and 2 should be checkpointed.
    const allContinuations = waves.flatMap((w) => w.continuationIds);
    assert.ok(allContinuations.includes("testville:cat=bakery:page1"));
    assert.ok(allContinuations.includes("testville:cat=bakery:page2"));
  });

  it("terminates a category on zero-card page (past-end)", async () => {
    const { result, waves } = await drive(
      ["bakery"],
      {
        "bakery:0": catHtmlWithPages([product("1")], 3),
        "bakery:1": "<html><body></body></html>", // empty page
        "bakery:2": "<html><body></body></html>",
      },
    );
    assert.equal(result.uniqueCount, 1);
    // page 0 + page 1 fetched; page 2 may or may not be in the same wave
    // The key assertion: empty pages are tracked and the crawl stopped cleanly.
    assert.ok(result.emptyPages.length >= 1, "should detect at least one empty page");
    assert.ok(
      result.emptyPages[0].includes("page1") || result.emptyPages[0].includes("page2"),
      "empty page id should reference the page that returned 0 products",
    );
  });

  it("dedupes overlapping products across categories", async () => {
    const { result } = await drive(
      ["bakery", "specials"],
      {
        "bakery:0": catHtmlWithPages(
          [product("1"), product("2")],
          1,
        ),
        "specials:0": catHtmlWithPages(
          [product("2"), product("3")],
          1,
        ),
      },
    );
    assert.equal(result.uniqueCount, 3); // 1, 2, 3
  });

  it("opens the circuit after BREAKER_THRESHOLD consecutive failures", async () => {
    const client = {
      consecutiveFailures: 0,
      circuitOpened: false,
      fetchSitemap: async () => [
        "https://s.fc.co.nz/category/a",
        "https://s.fc.co.nz/category/b",
        "https://s.fc.co.nz/category/c",
        "https://s.fc.co.nz/category/d",
        "https://s.fc.co.nz/category/e",
        "https://s.fc.co.nz/category/f",
      ],
      fetchCategoryPage: async () => {
        throw new Error("Network timeout");
      },
    };
    const recordedWaves = [];
    const result = await crawlStore({
      client,
      store,
      observedAt: "2026-08-27T00:00:00.000Z",
      commitWave: async (_obs, ids) => recordedWaves.push(ids),
      completed: new Map(),
      log: () => {},
      collectWarning: () => {},
    });
    // 6 tasks in one wave, 5 failures open the circuit.
    assert.match(
      result.error,
      new RegExp(`circuit opened after ${BREAKER_THRESHOLD} consecutive`),
    );
  });

  it("stops cleanly when budget runs out", async () => {
    const warnings = [];
    const { result } = await drive(
      ["bakery"],
      {
        "bakery:0": catHtmlWithPages([product("1")], 3),
      },
      {
        claimBudget: () => 0,
        collectWarning: (msg) => warnings.push(msg),
      },
    );
    assert.equal(result.budgetExhausted, true);
    assert.ok(warnings.some((w) => w.includes("budget")));
  });

  it("retries the sitemap when it transiently fails", async () => {
    // Same guard as the foodstuffs tree fetch: the sitemap is the store
    // crawl's bootstrap; a failing stretch must not abort the night.
    let sitemapCalls = 0;
    const sleeps = [];
    const warnings = [];
    const client = {
      fetchSitemap: async (origin) => {
        sitemapCalls += 1;
        if (sitemapCalls <= 2) throw new Error("sitemap 503");
        return [`${origin}/category/bakery`];
      },
      fetchCategoryPage: async (origin, categoryPath, page) => {
        assert.equal(categoryPath, "/category/bakery");
        assert.equal(page, 0);
        return catHtmlWithPages([product("1")], 1);
      },
    };
    const result = await crawlStore({
      client,
      store,
      observedAt: "2026-08-27T00:00:00.000Z",
      commitWave: async () => {},
      collectWarning: (msg) => warnings.push(msg),
      sleep: async (ms) => sleeps.push(ms),
    });

    assert.equal(sitemapCalls, 3);
    assert.equal(result.uniqueCount, 1);
    assert.ok(warnings.some((w) => w.includes("sitemap attempt 1 failed")));
    assert.ok(sleeps.length >= 2);
  });

  it("aborts the store crawl only after all sitemap retry rounds fail", async () => {
    let sitemapCalls = 0;
    await assert.rejects(
      crawlStore({
        client: {
          fetchSitemap: async () => {
            sitemapCalls += 1;
            throw new Error("503");
          },
          fetchCategoryPage: async () => {
            throw new Error("unreachable");
          },
        },
        store,
        observedAt: "2026-08-27T00:00:00.000Z",
        commitWave: async () => {},
        collectWarning: () => {},
        bootstrapRounds: 2,
        bootstrapGapMs: 5,
        sleep: () => Promise.resolve(),
      }),
      /503/,
    );
    assert.equal(sitemapCalls, 2);
  });
});

// ---- CLI parsing ----------------------------------------------------------

describe("parseArgs (FreshChoice)", () => {
  it("defaults to pilot file, 3000 delay, 800 budget", () => {
    const opts = parseArgs([]);
    assert.equal(opts.file, DEFAULT_FILE);
    assert.equal(opts.delayMs, DEFAULT_DELAY_MS);
    assert.equal(opts.budget, DEFAULT_PILOT_BUDGET);
  });

  it("parses explicit flags", () => {
    const opts = parseArgs([
      "--store", "Avondale",
      "--file", "/tmp/fc-test.jsonl",
      "--delay-ms", "1000",
      "--budget", "500",
    ]);
    assert.deepEqual(opts.storeQueries, ["Avondale"]);
    assert.equal(opts.file, "/tmp/fc-test.jsonl");
    assert.equal(opts.delayMs, 1000);
    assert.equal(opts.budget, 500);
  });

  it("rejects invalid values", () => {
    assert.throws(() => parseArgs(["--delay-ms", "-1"]), TypeError);
    assert.throws(() => parseArgs(["--budget", "0"]), TypeError);
    assert.throws(() => parseArgs(["--unknown"]), TypeError);
  });
});

// ---- end-to-end runCollection ---------------------------------------------

describe("end-to-end runCollection (FreshChoice, fake transport)", () => {
  function fakeTransport({ stores, sitemapCategories, pageScript }) {
    const storeListUrl = "https://store.freshchoice.co.nz/";
    return async (url) => {
      const str = String(url);
      // Store list: exact match only (not subdomains)
      if (str === storeListUrl || str.startsWith(storeListUrl + "?")) {
        return jsonResponse(stores);
      }
      if (str.includes("sitemap.xml")) {
        return jsonResponse(sitemapXml(sitemapCategories));
      }
      if (str.includes("/category/")) {
        // Extract category slug and page from URL
        const parsed = new URL(str);
        const path = parsed.pathname;
        const cat = path.replace("/category/", "");
        const page = parsed.searchParams.get("page");
        const key = `${cat}:${page ? Number(page) : 0}`;
        if (key in pageScript) return jsonResponse(pageScript[key]);
        throw new Error(`unscripted page: ${key} (${str})`);
      }
      throw new Error(`unexpected URL ${str}`);
    };
  }

  function storeCardHtml(stores) {
    return stores
      .map(
        (s) =>
          `<div class="StoreCard">
            <span class="StoreCard__Name">${s.name}</span>
            <span class="StoreCard__Details">${s.address ?? ""}</span>
            <a href="${s.origin}">Shop</a>
          </div>`,
      )
      .join("\n");
  }

  it("crawls one store end-to-end with archive output", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-breadth-e2e-"));
    try {
      const file = join(dir, "breadth-pilot-fc.jsonl");
      const transport = fakeTransport({
        stores: storeCardHtml([
          {
            name: "Testville",
            origin: "https://testville.store.freshchoice.co.nz",
          },
        ]),
        sitemapCategories: ["bakery", "dairy"],
        pageScript: {
          "bakery:0": catHtmlWithPages([product("1"), product("2")], 1),
          "dairy:0": catHtmlWithPages([product("3")], 1),
        },
      });

      const summary = await runCollection({
        transport,
        file,
        delayMs: 0,
        budget: 100,
        minExpectedProducts: 1,
        observedAt: "2026-08-27T00:00:00.000Z",
        log: () => {},
        collectWarning: () => {},
      });

      assert.equal(summary.healthy, true);
      assert.equal(summary.stores.length, 1);
      assert.equal(summary.stores[0].name, "FreshChoice Testville");
      assert.equal(summary.stores[0].uniqueProducts, 3);

      // Finding 10: exact expected request-set.
      // Expected: 1 store-list fetch + 1 probe-sitemap + 1 crawl-sitemap + 2 category page-0 fetches = 5
      assert.equal(summary.httpRequestsAdmitted, 5);

      // Finding 9: source URL uses /lines/<id> family.
      const raw = await readFile(file, "utf8");
      const lines = raw.trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(lines.some((r) => r.type === "snapshot"), false);
      assert.equal(lines.every((r) => r.version === 2), true);
      assert.equal(lines.filter((r) => r.type === "offer").length, 3);
      assert.equal(lines.filter((r) => r.type === "product").length, 3);
      assert.equal(lines.filter((r) => r.type === "store").length, 1);

      // Assert every source.url contains /lines/.
      for (const line of lines) {
        if (line.type === "offer" && line.source?.url) {
          assert.ok(
            line.source.url.includes("/lines/"),
            `source.url should contain /lines/: ${line.source.url}`,
          );
        }
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resume skips recorded continuation pages on second run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-breadth-resume-"));
    try {
      const file = join(dir, "breadth-pilot-fc.jsonl");

      // A store with one multi-page category
      const scriptPages = {
        "bakery:0": catHtmlWithPages([product("1")], 3),
        "bakery:1": catHtmlWithPages([product("2")], 1),
        "bakery:2": catHtmlWithPages([product("3")], 1),
      };

      function makeTransport() {
        const urls = [];
        const transport = fakeTransport({
          stores: storeCardHtml([
            {
              name: "Testville",
              origin: "https://testville.store.freshchoice.co.nz",
            },
          ]),
          sitemapCategories: ["bakery"],
          pageScript: { ...scriptPages },
        });
        return {
          transport: async (url, init) => {
            urls.push(String(url));
            return transport(url, init);
          },
          urls,
        };
      }

      const common = {
        delayMs: 0,
        budget: 100,
        minExpectedProducts: 1,
        observedAt: "2026-08-27T00:00:00.000Z",
        log: () => {},
        collectWarning: () => {},
      };

      // First run
      const { transport: transport1, urls: urls1 } = makeTransport();
      const first = await runCollection({
        ...common,
        transport: transport1,
        file,
      });
      assert.equal(first.healthy, true);
      assert.equal(first.stores[0].uniqueProducts, 3);

      // Manifest should checkpoint pages 1 and 2
      const manifest = JSON.parse(
        await readFile(`${file}.breadth-manifest.json`, "utf8"),
      );
      const continuationIds = Object.keys(manifest.completed).sort();
      assert.deepEqual(continuationIds, [
        "testville:cat=bakery:page1",
        "testville:cat=bakery:page2",
      ]);

      // Record which URLs were hit in run 1 (for cross-check)
      const run1ContinuationUrls = urls1.filter((u) => u.includes("/category/bakery?page="));
      assert.equal(run1ContinuationUrls.length, 2);

      // Second run — recorded pages must be SKIPPED.
      const { transport: transport2, urls: urls2 } = makeTransport();
      const second = await runCollection({
        ...common,
        transport: transport2,
        file,
      });
      assert.equal(second.healthy, true);

      // Assert: run 2 issues ZERO continuation URLs that were in run 1's manifest.
      const run2ContinuationUrls = urls2.filter((u) =>
        // Real shape per the adapter: /category/<slug>?page=<n>
        /\/category\/bakery\?page=(1|2)([&/]|$)/.test(u),
      );
      assert.deepEqual(
        run2ContinuationUrls,
        [],
        `run 2 refetched recorded pages: ${run2ContinuationUrls.join(", ")}`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pilot picks alphabetically-first store when no --store given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-breadth-pilot-"));
    try {
      const file = join(dir, "breadth-pilot-fc.jsonl");
      const transport = fakeTransport({
        stores: storeCardHtml([
          {
            name: "Zanytown",
            origin: "https://zanytown.store.freshchoice.co.nz",
          },
          {
            name: "Avondale",
            origin: "https://avondale.store.freshchoice.co.nz",
          },
        ]),
        sitemapCategories: ["bakery"],
        pageScript: {
          "bakery:0": catHtmlWithPages([product("1")], 1),
        },
      });
      const summary = await runCollection({
        transport,
        file,
        delayMs: 0,
        budget: 100,
        minExpectedProducts: 1,
        observedAt: "2026-08-27T00:00:00.000Z",
        log: () => {},
        collectWarning: () => {},
      });
      // Pilot should pick Avondale (alphabetically first, verified crawlable)
      assert.equal(summary.stores.length, 1);
      assert.ok(summary.stores[0].name.includes("Avondale"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pilot skips unreachable storefronts and picks the next", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-breadth-pilot-skip-"));
    try {
      const file = join(dir, "breadth-pilot-fc.jsonl");
      // Avondale's sitemap will fail; Zanytown's will succeed.
      let callIndex = 0;
      const transport = fakeTransport({
        stores: storeCardHtml([
          {
            name: "Avondale",
            origin: "https://avondale.store.freshchoice.co.nz",
          },
          {
            name: "Zanytown",
            origin: "https://zanytown.store.freshchoice.co.nz",
          },
        ]),
        sitemapCategories: ["bakery"],
        pageScript: {
          "bakery:0": catHtmlWithPages([product("7")], 1),
        },
      });
      // Wrap to make Avondale's sitemap return non-OK on first attempt
      const failFirstTransport = async (url, init) => {
        const str = String(url);
        if (str.includes("avondale") && str.includes("sitemap.xml")) {
          return { ok: false, status: 500, text: async () => "err", headers: new Headers() };
        }
        return transport(url, init);
      };
      const observedUrls = [];
      const countingWrap = async (url, init) => {
        observedUrls.push(String(url));
        return failFirstTransport(url, init);
      };
      const summary = await runCollection({
        transport: countingWrap,
        file,
        delayMs: 0,
        budget: 100,
        minExpectedProducts: 1,
        observedAt: "2026-08-27T00:00:00.000Z",
        log: () => {},
        collectWarning: () => {},
      });
      // Pilot should skip Avondale and pick Zanytown
      assert.equal(summary.stores.length, 1);
      assert.ok(summary.stores[0].name.includes("Zanytown"));
      // Verify probe happened for Avondale first
      const probeUrl = observedUrls.find((u) => u.includes("avondale") && u.includes("sitemap.xml"));
      assert.ok(probeUrl, "Avondale sitemap should have been probed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("flags a run as unhealthy when unique products land below the floor", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fc-breadth-floor-"));
    try {
      const file = join(dir, "breadth-pilot-fc.jsonl");
      const transport = fakeTransport({
        stores: storeCardHtml([{ name: "Testville", origin: "https://testville.store.freshchoice.co.nz" }]),
        sitemapCategories: ["bakery"],
        pageScript: { "bakery:0": catHtmlWithPages([product("1")], 1) },
      });
      const summary = await runCollection({
        transport,
        file,
        delayMs: 0,
        budget: 100,
        minExpectedProducts: 5,
        sleep: async () => {},
        observedAt: "2026-08-27T00:00:00.000Z",
        log: () => {},
        collectWarning: () => {},
      });

      assert.equal(summary.stores[0].uniqueProducts, 1);
      assert.equal(summary.healthy, false);
      assert.equal(summary.minExpectedProducts, 5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pilot defaults and live archive guard", async () => {
    assert.equal(DEFAULT_DELAY_MS, 3000);
    assert.equal(DEFAULT_FILE, "data/breadth-pilot-fc.jsonl");
    assert.equal(DEFAULT_PILOT_BUDGET, 800);

    let networkTouched = false;
    const transport = () => {
      networkTouched = true;
      throw new Error("must not be reached");
    };
    await assert.rejects(
      () =>
        runCollection({
          transport,
          file: "data/prices.jsonl",
          delayMs: 0,
          log: () => {},
          collectWarning: () => {},
        }),
      /Refusing to breadth-collect/,
    );
    assert.equal(networkTouched, false);
    // Direct guard also works
    assert.throws(() => assertNotLiveArchive("data/prices.jsonl"), /Refusing/);
    assert.doesNotThrow(() =>
      assertNotLiveArchive("data/breadth-pilot-fc.jsonl"),
    );
  });
});