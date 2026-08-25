import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_PILOT_BUDGET,
  absorbHits,
  assertNotLiveArchive,
  categoryFilters,
  categoryKey,
  continuationPages,
  createCrawlerBridge,
  crawlStore,
  facetEntries,
  needsSplit,
  parseArgs,
  parseSearchRequest,
  reconcile,
  resolveStores,
  runCollection,
  taskId,
  tobaccoTarget,
} from "../scripts/foodstuffs-breadth.js";
import { createCrawler } from "../scripts/lib/crawler.js";

// ---- fixture builders ----------------------------------------------------

/** One Foodstuffs product hit carrying the fields the adapter reads. */
function hit(id, price = 500) {
  return {
    productId: `${id}-EA-000`,
    name: `Product ${id}`,
    brand: "Test Brand",
    singlePrice: { price, promoId: null, comparativePrice: null },
    multiPrice: { price: null },
    price,
    promotions: [],
    decalCode: null,
    decalImageUrl: null,
    categoryTrees: [{ level0: "Pantry", level1: null, level2: null }],
    categories: null,
    unitPrice: null,
  };
}

/**
 * A synthetic Algolia search envelope. `hits` are returned verbatim; facets
 * and totals drive the planner. totalHits defaults to hits.length so leaf
 * fixtures are exact unless stated.
 */
function envelope({
  hits = [],
  facets = {},
  totalHits,
  totalPages,
} = {}) {
  const resolvedTotal = totalHits ?? hits.length;
  return {
    tobaccoProducts: [],
    products: hits,
    algoliaSearchResult: { facets },
    totalHits: resolvedTotal,
    page: 0,
    totalPages: totalPages ?? Math.max(1, Math.ceil(resolvedTotal / 50)),
    hitsPerPage: 50,
    sortOrder: "NI_POPULARITY_ASC",
  };
}

const store = {
  id: "store-1",
  name: "PAK'nSAVE Testville",
  address: "1 Test Road",
  region: "NI",
};

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    headers: new Headers(),
  };
}

/** Store-list envelope for listStores(). */
function storesEnvelope(stores, defaultBanner) {
  return {
    stores: stores.map((entry) => ({
      id: entry.id,
      name: entry.name,
      address: entry.address ?? "",
      banner: entry.banner ?? defaultBanner,
    })),
  };
}

// ---- pure helpers ---------------------------------------------------------

describe("planner helpers", () => {
  it("builds stable category keys and task ids", () => {
    assert.equal(categoryKey([]), "all");
    assert.equal(categoryKey(["Pantry"]), "cat0=Pantry");
    assert.equal(categoryKey(["Pantry", "Breakfast"]), "cat0=Pantry|cat1=Breakfast");
    assert.equal(taskId("s1", ["Pantry"], 2), "s1:cat0=Pantry:page2");
    assert.equal(taskId("s1", [], 0), "s1:all:page0");
  });

  it("derives filters and parses them back into the same plan", () => {
    const path = ["Chilled & Dairy", "Yoghurt"];
    assert.deepEqual(
      categoryFilters(path),
      ['category0NI:"Chilled & Dairy"', 'category1NI:"Yoghurt"'],
    );
    // The bridge derives ids from the request body; pin it to the ids the
    // collector computes so manifest keys agree across both paths.
    const init = {
      method: "POST",
      body: JSON.stringify({
        algoliaQuery: {
          filters: `stores:${store.id} AND ${categoryFilters(path).join(" AND ")}`,
        },
        page: 4,
      }),
    };
    assert.deepEqual(parseSearchRequest(init), {
      storeId: store.id,
      categoryPath: path,
      page: 4,
    });
    assert.equal(parseSearchRequest({ body: "not json" }), null);
    assert.equal(parseSearchRequest(undefined), null);
  });

  it("reads the uncapped catalogue target and facet entries", () => {
    const env = envelope({
      facets: { tobacco: { false: 9445 }, category0NI: { Pantry: 2904, Featured: 120 } },
    });
    assert.equal(tobaccoTarget(env), 9445);
    assert.equal(tobaccoTarget(envelope()), undefined);
    assert.deepEqual(facetEntries(env, "category0NI"), [
      { name: "Featured", count: 120 },
      { name: "Pantry", count: 2904 },
    ]);
    assert.deepEqual(facetEntries(envelope(), "category1NI"), []);
  });

  it("splits only above the 900 threshold and paginates leaves fully", () => {
    assert.equal(needsSplit({ count: 900 }), false);
    assert.equal(needsSplit({ count: 901 }), true);

    assert.deepEqual(continuationPages(envelope({ totalHits: 40 })), {
      pages: [],
      truncated: false,
    });
    assert.deepEqual(continuationPages(envelope({ totalHits: 130 })), {
      pages: [1, 2],
      truncated: false,
    });
    // Saturation of the Algolia clamp flags an unreachable tail.
    assert.deepEqual(continuationPages(envelope({ totalHits: 1000, totalPages: 20 })), {
      pages: Array.from({ length: 19 }, (_, index) => index + 1),
      truncated: true,
    });
  });

  it("dedupes hits by productId keeping first sight", () => {
    const seen = new Map();
    const first = absorbHits(seen, [
      hit("5004821", 860),
      { name: "no id" },
    ]);
    assert.equal(first.length, 1);
    const second = absorbHits(seen, [hit("5004821", 999), hit("6000001")]);
    // Keep-first: the second sighting (price 999) must not win.
    assert.deepEqual(second.map((product) => product.productId), ["6000001-EA-000"]);
    assert.equal(seen.get("5004821-EA-000").singlePrice.price, 860);
  });

  it("reconciles coverage against the catalogue target", () => {
    assert.deepEqual(reconcile(10, undefined), {
      target: undefined,
      delta: undefined,
      deltaRatio: undefined,
      withinTolerance: true,
    });
    assert.equal(reconcile(9445, 9445).withinTolerance, true);
    assert.equal(reconcile(9443, 9445).withinTolerance, true); // ~0.02% under
    assert.equal(reconcile(9390, 9445).withinTolerance, false); // ~0.58% under
    assert.equal(reconcile(9520, 9445).withinTolerance, false); // ~0.79% over
    assert.equal(reconcile(0, 0).withinTolerance, true);
  });
});

// ---- crawl algorithm ------------------------------------------------------

describe("crawlStore planning", () => {
  function filtersToPath(extraFilters = []) {
    const path = [];
    for (const level of ["category0NI", "category1NI"]) {
      const match = extraFilters.find((filter) => filter.startsWith(`${level}:`));
      if (!match) break;
      path.push(match.match(/"([^"]+)"/)[1]);
    }
    return path;
  }

  /**
   * Drive crawlStore against envelopes scripted per task id, collecting the
   * committed waves. Unscripted task ids fail loudly.
   */
  async function drive(scripted, options = {}) {
    const waves = [];
    const fetchedIds = [];
    const client = {
      retailer: "paknsave",
      searchProducts: async ({ storeId, page, extraFilters }) => {
        const key = taskId(storeId, filtersToPath(extraFilters), page);
        fetchedIds.push(key);
        if (!(key in scripted)) throw new Error(`unexpected task ${key}`);
        return typeof scripted[key] === "function"
          ? scripted[key]()
          : scripted[key];
      },
    };
    const result = await crawlStore({
      client,
      store,
      observedAt: "2026-08-25T00:00:00.000Z",
      commitWave: async (observations, continuationIds) => {
        waves.push({ observations, continuationIds });
      },
      collectWarning: () => {},
      ...options,
    });
    return { result, waves, fetchedIds };
  }

  it("drills down big categories, paginates small ones, dedupes overlaps", async () => {
    // Pantry is huge (split into children via its scoped facet); Household
    // fits in two pages; "Featured" re-lists products already seen.
    const scripted = {
      "store-1:all:page0": envelope({
        hits: [hit("1"), hit("2")],
        facets: {
          tobacco: { false: 5 },
          category0NI: { Pantry: 2000, Household: 80, Featured: 90 },
        },
      }),
      "store-1:cat0=Pantry:page0": envelope({
        hits: [hit("3")],
        totalHits: 2000,
        totalPages: 40,
        facets: { category1NI: { Breakfast: 400, Snacks: 300 } },
      }),
      "store-1:cat0=Pantry|cat1=Breakfast:page0": envelope({
        hits: [hit("4")],
        totalHits: 400,
        totalPages: 8,
      }),
      "store-1:cat0=Pantry|cat1=Snacks:page0": envelope({
        hits: [hit("4"), hit("5")], // overlap with Breakfast
        totalHits: 300,
        totalPages: 6,
      }),
      ...Object.fromEntries(
        [...Array(7).keys(), ...Array(5).keys()].flatMap((page) => [
          // Continuation pages re-list earlier products (popularity order
          // repeats); they are never EMPTY in reality — an empty page means
          // the API over-reported totalPages and the collector warns.
          [`store-1:cat0=Pantry|cat1=Breakfast:page${page + 1}`, envelope({ hits: [hit("4")], totalHits: 400 })],
          [`store-1:cat0=Pantry|cat1=Snacks:page${page + 1}`, envelope({ hits: [hit("5")], totalHits: 300 })],
        ]),
      ),
      "store-1:cat0=Featured:page0": envelope({
        hits: [hit("2"), hit("4")], // pure pseudo-category overlap
        totalHits: 90,
        totalPages: 2,
      }),
      "store-1:cat0=Featured:page1": envelope({
        hits: [hit("2")],
        totalHits: 90,
      }),
      "store-1:cat0=Household:page0": envelope({
        hits: [hit("1")], // pseudo-category overlap with root
        totalHits: 80,
        totalPages: 2,
      }),
      "store-1:cat0=Household:page1": envelope({
        hits: [hit("2")],
        totalHits: 80,
      }),
    };

    const { result, waves, fetchedIds } = await drive(scripted);

    // Deduped unique set: products 1..5 exactly once each (target 5).
    assert.equal(result.uniqueCount, 5);
    assert.deepEqual(result.reconciliation.delta, 0);
    assert.ok(result.reconciliation.withinTolerance);
    assert.deepEqual(result.warnings, []);
    assert.ok(result.rootFound);

    // The huge category spawned child leaves instead of self-pagination:
    // no cat0=Pantry continuation page may have been fetched...
    for (const id of fetchedIds) {
      assert.doesNotMatch(id, /^store-1:cat0=Pantry:page[1-9]\d*$/);
    }
    // ...and its page-0 was fetched exactly once (the split decision).
    assert.equal(fetchedIds.filter((id) => id === "store-1:cat0=Pantry:page0").length, 1);
    // Small category paginated fully.
    assert.ok(fetchedIds.includes("store-1:cat0=Household:page1"));
    // Discovery waves never checkpoint; only continuation pages do.
    assert.deepEqual(waves[0].continuationIds, []);
    const allContinuations = waves.flatMap((wave) => wave.continuationIds);
    assert.ok(allContinuations.includes("store-1:cat0=Household:page1"));
    for (const id of allContinuations) {
      assert.match(id, /:page([1-9]\d*)$/);
    }
  });

  it("warns when coverage misses the 0.5% tolerance", async () => {
    const warnings = [];
    const scripted = {
      "store-1:all:page0": envelope({
        hits: [hit("1")],
        facets: { tobacco: { false: 100 }, category0NI: { Pantry: 95 } },
      }),
      "store-1:cat0=Pantry:page0": envelope({ hits: [hit("2")], totalHits: 95 }),
    };
    const { result } = await drive(scripted, {
      collectWarning: (message) => warnings.push(message),
    });
    assert.equal(result.uniqueCount, 2);
    assert.equal(result.reconciliation.target, 100);
    assert.equal(result.reconciliation.withinTolerance, false);
    assert.ok(warnings.some((message) => message.includes("coverage 2 unique vs 100")));
  });

  it("flags a missing tobacco:false facet as unreconcilable", async () => {
    const warnings = [];
    const scripted = {
      "store-1:all:page0": envelope({ facets: { category0NI: {} } }),
    };
    const { result } = await drive(scripted, {
      collectWarning: (message) => warnings.push(message),
    });
    assert.equal(result.rootFound, false);
    assert.ok(warnings.some((message) => message.includes("tobacco:false")));
  });

  it("stops cleanly when the search budget runs out mid-crawl", async () => {
    const scripted = {
      "store-1:all:page0": envelope({
        facets: { tobacco: { false: 10 }, category0NI: { Pantry: 50 } },
      }),
    };
    const warnings = [];
    const { result } = await drive(scripted, {
      claimBudget: () => 0,
      collectWarning: (message) => warnings.push(message),
    });
    assert.equal(result.budgetExhausted, true);
    assert.equal(result.uniqueCount, 0);
    assert.ok(warnings.some((message) => message.includes("budget")));
  });

  it("warns on a split-child that itself exceeds the clamp", async () => {
    const warnings = [];
    const scripted = {
      "store-1:all:page0": envelope({
        facets: { tobacco: { false: 500 }, category0NI: { Pantry: 3000 } },
      }),
      "store-1:cat0=Pantry:page0": envelope({
        totalHits: 3000,
        totalPages: 60,
        facets: { category1NI: { Bulk: 1500 } },
      }),
      "store-1:cat0=Pantry|cat1=Bulk:page0": envelope({
        totalHits: 1500,
        totalPages: 30,
        truncatedHint: undefined,
      }),
    };
    const { result } = await drive(scripted, {
      collectWarning: (message) => warnings.push(message),
    });
    assert.ok(
      warnings.some((message) => message.includes('child "Bulk"')),
    );
    // The oversized leaf saturates the clamp → truncation warning too.
    assert.ok(warnings.some((message) => message.includes("clamp")));
  });
});

// ---- crawler bridge -------------------------------------------------------

describe("crawler bridge", () => {
  function makeCrawler(transport) {
    return createCrawler({
      fetch: transport,
      minHostDelayMs: 0,
      clock: () => 0,
      sleep: async () => {},
    });
  }

  it("routes client calls as tasks and resolves transport responses", async () => {
    const calls = [];
    const transport = async () => {
      calls.push(1);
      return jsonResponse({ ok: true });
    };
    const bridge = createCrawlerBridge({ crawler: makeCrawler(transport) });
    const init = {
      method: "POST",
      body: JSON.stringify({ algoliaQuery: { filters: "stores:s1" }, page: 0 }),
    };
    const responses = await Promise.all([
      bridge.fetch("https://api.example/search", init),
      bridge.fetch("https://api.example/user", { method: "POST", body: "{}" }),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [200, 200]);
    assert.equal(bridge.admittedCount(), 2);
    assert.equal(calls.length, 2);
  });

  it("rejects admissions past the budget with EBREADTHBUDGET", async () => {
    const transport = async () => jsonResponse({});
    const bridge = createCrawlerBridge({
      crawler: makeCrawler(transport),
      budget: 1,
    });
    await assert.rejects(
      Promise.all([
        bridge.fetch("https://api.example/a", {}),
        bridge.fetch("https://api.example/b", {}),
      ]),
      (error) => error.code === "EBREADTHBUDGET",
    );
    // A call queued after exhaustion must reject, not hang.
    await assert.rejects(bridge.fetch("https://api.example/c", {}));
  });

  it("rejects failed outcomes with a category-naming error", async () => {
    const transport = async () => ({
      status: 404,
      body: null,
      headers: new Headers(),
    });
    const bridge = createCrawlerBridge({ crawler: makeCrawler(transport) });
    await assert.rejects(
      bridge.fetch("https://api.example/gone", {}),
      /breadth request failed \(fatal-http\)/,
    );
  });
});

// ---- CLI parsing & store resolution ---------------------------------------

describe("CLI surface", () => {
  it("defaults to the pilot pair and the pilot archive file", () => {
    const options = parseArgs([]);
    assert.equal(options.retailer, "both");
    assert.deepEqual(options.storeQueries, []);
    assert.equal(options.file, "data/breadth-pilot.jsonl");
    assert.equal(options.delayMs, 1000);
    assert.equal(options.budget, Number.POSITIVE_INFINITY);
  });

  it("parses explicit options and rejects bad values", () => {
    const parsed = parseArgs([
      "--retailer", "newworld",
      "--store", "Royal Oak",
      "--store", "abc-123",
      "--file", "/tmp/x.jsonl",
      "--delay-ms", "2500",
      "--budget", "500",
    ]);
    assert.equal(parsed.retailer, "newworld");
    assert.deepEqual(parsed.storeQueries, ["Royal Oak", "abc-123"]);
    assert.equal(parsed.file, "/tmp/x.jsonl");
    assert.equal(parsed.delayMs, 2500);
    assert.equal(parsed.budget, 500);

    assert.throws(() => parseArgs(["--retailer", "countdown"]), TypeError);
    assert.throws(() => parseArgs(["--delay-ms", "-5"]), TypeError);
    assert.throws(() => parseArgs(["--budget", "0"]), TypeError);
    assert.throws(() => parseArgs(["--budget", "1.5"]), TypeError);
    assert.throws(() => parseArgs(["--mystery"]), TypeError);
    assert.throws(() => parseArgs(["--file"]), TypeError);
  });

  it("resolves stores by exact id/name or unambiguous fragment", () => {
    const allStores = [
      { id: "aaa", name: "PAK'nSAVE Auckland Central", address: "1 A St" },
      { id: "bbb", name: "PAK'nSAVE Royal Oak", address: "2 B St" },
      { id: "ccc", name: "New World Remuera", address: "3 C St" },
    ];
    assert.equal(resolveStores(["bbb"], allStores)[0].name, "PAK'nSAVE Royal Oak");
    assert.equal(resolveStores(["royal oak"], allStores)[0].id, "bbb");
    assert.equal(resolveStores(["Remuera"], allStores)[0].id, "ccc");
    assert.throws(() => resolveStores(["nope"], allStores), /No store matches/);
    assert.throws(() => resolveStores(["a"], allStores), /ambiguous/);
  });
});

// ---- end-to-end -----------------------------------------------------------

describe("end-to-end runCollection (fake transport)", () => {
  /** Fake transport scripting auth, store lists, and searches per banner. */
  function fakeFoodstuffsTransport({ paknsaveStores, newworldStores }) {
    const impl = async (url, init) => {
      const origin = new URL(url).origin;
      if (String(url).endsWith("/api/user/get-current-user")) {
        return jsonResponse({ access_token: `token-${origin}` });
      }
      if (String(url).endsWith("/v1/edge/store")) {
        const isPns = origin.includes("paknsave");
        const list = isPns ? paknsaveStores : newworldStores;
        return jsonResponse(storesEnvelope(list, isPns ? "PNS" : "MNW"));
      }
      if (String(url).endsWith("/v1/edge/search/paginated/products")) {
        impl.searchCalls.push({ url: String(url), init: init ?? null });
        const body = JSON.parse(init.body);
        const filters = body.algoliaQuery.filters;
        const key = `${origin.includes("paknsave") ? "pns" : "nw"}:${
          filters.match(/stores:([^\s]+)/)[1]
        }`;
        if (!impl.searchScript[key]) throw new Error(`unscripted search ${key}`);
        return jsonResponse(impl.searchScript[key](filters, body.page ?? 0));
      }
      throw new Error(`unexpected URL ${url}`);
    };
    impl.searchScript = {};
    impl.searchCalls = [];
    return impl;
  }

  /**
   * One store's script: 63-product catalogue — root lists product r;
   * Pantry holds p0..p59 across two pages; Household re-lists r plus h1,h2.
   */
  function pilotScript(base) {
    return (filters, page) => {
      if (!filters.includes("category0NI:")) {
        return envelope({
          hits: [hit(`${base}-r`)],
          facets: { tobacco: { false: 63 }, category0NI: { Pantry: 60, Household: 3 } },
        });
      }
      if (filters.includes('category0NI:"Pantry"')) {
        return page === 0
          ? envelope({
              hits: Array.from({ length: 50 }, (_, i) => hit(`${base}-p${i}`)),
              totalHits: 60,
            })
          : envelope({
              hits: Array.from({ length: 10 }, (_, i) => hit(`${base}-p${i + 50}`)),
              totalHits: 60,
            });
      }
      return envelope({
        hits: [hit(`${base}-r`), hit(`${base}-h1`), hit(`${base}-h2`)],
      });
    };
  }

  it("crawls the pilot pair, appends offer revisions only, reconciles", async () => {
    const dir = await mkdtemp(join(tmpdir(), "breadth-e2e-"));
    try {
      const file = join(dir, "nested", "breadth-pilot.jsonl");
      const transport = fakeFoodstuffsTransport({
        paknsaveStores: [
          { id: "pns-a", name: "PAK'nSAVE Zeta" },
          { id: "pns-b", name: "PAK'nSAVE Alpha" },
        ],
        newworldStores: [
          { id: "nw-a", name: "New World Omega" },
          { id: "nw-b", name: "New World Beta" },
        ],
      });
      transport.searchScript["pns:pns-b"] = pilotScript("5");
      transport.searchScript["nw:nw-b"] = pilotScript("7");

      const summary = await runCollection({
        transport,
        file,
        delayMs: 0,
        observedAt: "2026-08-25T00:00:00.000Z",
        log: () => {},
        collectWarning: () => {},
      });

      // Pilot default: first store alphabetically per banner.
      assert.deepEqual(summary.stores.map((entry) => entry.name), [
        "PAK'nSAVE Alpha",
        "New World Beta",
      ]);
      // 63 unique products per store (r + p0..p59 + h1,h2), reconciling
      // exactly against the 63-product catalogue target.
      for (const entry of summary.stores) {
        assert.equal(entry.uniqueProducts, 63);
        assert.equal(entry.target, 63);
        assert.equal(entry.delta, 0);
        assert.equal(entry.coverageOk, true);
        assert.deepEqual(entry.warnings, []);
      }
      assert.equal(summary.healthy, true);

      // Archive contents: v2 offer revisions ONLY — no snapshot records.
      const raw = await readFile(file, "utf8");
      const lines = raw.trim().split("\n").map((line) => JSON.parse(line));
      assert.equal(lines.some((record) => record.type === "snapshot"), false);
      assert.equal(lines.every((record) => record.version === 2), true);
      assert.equal(lines.filter((record) => record.type === "offer").length, 126);
      assert.equal(lines.filter((record) => record.type === "product").length, 126);
      assert.equal(lines.filter((record) => record.type === "store").length, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resume skips recorded continuation pages on a second run", async () => {    const dir = await mkdtemp(join(tmpdir(), "breadth-resume-"));
    try {
      const file = join(dir, "breadth-pilot.jsonl");
      const transport = fakeFoodstuffsTransport({
        paknsaveStores: [{ id: "pns-a", name: "PAK'nSAVE Alpha" }],
        newworldStores: [{ id: "nw-a", name: "New World Omega" }],
      });
      transport.searchScript["pns:pns-a"] = pilotScript("5");
      // New World: tiny single-page catalogue (only discovery requests).
      transport.searchScript["nw:nw-a"] = (filters) => {
        if (filters.includes("category0NI:")) {
          // Pantry re-lists r plus one Pantry-only product → 2 unique.
          return envelope({ hits: [hit("9-r"), hit("9-p")], totalHits: 2 });
        }
        return envelope({
          hits: [hit("9-r")],
          facets: { tobacco: { false: 2 }, category0NI: { Pantry: 2 } },
        });
      };

      const common = {
        transport,
        file,
        delayMs: 0,
        observedAt: "2026-08-25T00:00:00.000Z",
        log: () => {},
        collectWarning: () => {},
      };

      const searchUrls = () =>
        transport.searchCalls.filter((entry) =>
          entry.url.endsWith("/v1/edge/search/paginated/products"),
        );
      const requestedPages = () =>
        searchUrls().map((entry) => JSON.parse(entry.init.body));

      const first = await runCollection(common);
      assert.equal(first.stores.every((entry) => entry.coverageOk), true);

      // Manifest checkpoints the PNS continuation page; NW's tiny catalogue
      // is fully covered by discovery requests and checkpoints nothing.
      const manifest = JSON.parse(await readFile(`${file}.breadth-manifest.json`, "utf8"));
      assert.deepEqual(Object.keys(manifest.completed), [
        "pns-a:cat0=Pantry:page1",
      ]);

      // Second run with EMPTY replays: any refetch of a recorded page would
      // surface as an empty page-1 request. Recorded pages must be skipped.
      transport.searchCalls.length = 0;
      const emptyReplay = (scriptFactory) => (filters, page) => {
        const env = scriptFactory(filters, page);
        return { ...env, products: [] };
      };
      transport.searchScript["pns:pns-a"] = emptyReplay(pilotScript("5"));
      transport.searchScript["nw:nw-a"] = emptyReplay(transport.searchScript["nw:nw-a"]);

      const second = await runCollection(common);
      // No page-1 request may appear for either store.
      for (const body of requestedPages()) {
        const filters = body.algoliaQuery.filters;
        if (!filters.includes("category0NI:")) continue;
        assert.notEqual(body.page, 1, "recorded page-1 must not be refetched");
      }
      assert.equal(second.observationsRecorded, 0);
      const manifestAfter = JSON.parse(
        await readFile(`${file}.breadth-manifest.json`, "utf8"),
      );
      assert.deepEqual(manifestAfter.completed, manifest.completed);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("a lost manifest re-crawls safely — archive dedupes, nothing duplicates", async () => {
    const dir = await mkdtemp(join(tmpdir(), "breadth-lost-manifest-"));
    try {
      const file = join(dir, "breadth-pilot.jsonl");
      const manifestPath = `${file}.breadth-manifest.json`;
      const transport = fakeFoodstuffsTransport({
        paknsaveStores: [{ id: "pns-a", name: "PAK'nSAVE Alpha" }],
        newworldStores: [{ id: "nw-a", name: "New World Omega" }],
      });
      transport.searchScript["pns:pns-a"] = pilotScript("5");
      transport.searchScript["nw:nw-a"] = (filters) =>
        envelope({ hits: [hit("9-r")], facets: { tobacco: { false: 1 }, category0NI: {} } });
      const common = {
        transport,
        file,
        delayMs: 0,
        observedAt: "2026-08-25T00:00:00.000Z",
        log: () => {},
        collectWarning: () => {},
      };

      const first = await runCollection(common);
      assert.equal(first.healthy, true);
      const linesAfterFirst = (await readFile(file, "utf8")).trim().split("\n").length;

      // Crash-between-append-and-persist, worst case: the manifest is GONE
      // while the archive keeps every record. The next run must re-crawl
      // everything and land zero duplicate records (content-hash dedup).
      await rm(manifestPath);
      const second = await runCollection(common);
      assert.equal(second.healthy, true);
      assert.equal(second.observationsRecorded, 0, "dedup swallows the re-crawl");
      const linesAfterSecond = (await readFile(file, "utf8")).trim().split("\n").length;
      assert.equal(linesAfterSecond, linesAfterFirst);

      // And the recreated manifest again checkpoints continuation pages.
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.deepEqual(Object.keys(manifest.completed), [
        "pns-a:cat0=Pantry:page1",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("pilot defaults are bounded and the live archive is refused", async () => {
    assert.equal(DEFAULT_PILOT_BUDGET, 2000);
    assert.equal(parseArgs(["--force-live"]).forceLive, true);

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
    assert.equal(networkTouched, false, "guard must fire before any request");
    // The API-level guard is directly usable and env-aware.
    assert.throws(
      () => assertNotLiveArchive("data/prices.jsonl"),
      /Refusing to breadth-collect/,
    );
    assert.doesNotThrow(() => assertNotLiveArchive("data/breadth-pilot.jsonl"));
  });

  it("explicit --store queries select stores per selected banner", async () => {
    const dir = await mkdtemp(join(tmpdir(), "breadth-stores-"));
    try {
      const file = join(dir, "breadth.jsonl");
      const transport = fakeFoodstuffsTransport({
        paknsaveStores: [{ id: "pns-a", name: "PAK'nSAVE Alpha" }],
        newworldStores: [{ id: "nw-a", name: "New World Omega" }],
      });
      const tinyCatalogue = () =>
        envelope({ facets: { tobacco: { false: 1 }, category0NI: {} } });
      transport.searchScript["pns:pns-a"] = tinyCatalogue;
      transport.searchScript["nw:nw-a"] = tinyCatalogue;

      const summary = await runCollection({
        transport,
        file,
        delayMs: 0,
        storeQueries: ["Alpha"],
        observedAt: "2026-08-25T00:00:00.000Z",
        log: () => {},
        collectWarning: () => {},
      });
      assert.deepEqual(summary.stores.map((entry) => entry.name), [
        "PAK'nSAVE Alpha",
        "New World Omega",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
