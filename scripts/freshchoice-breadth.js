#!/usr/bin/env node
/**
 * BREADTH-2 — FreshChoice full-catalogue breadth collector.
 *
 * Per storefront subdomain:
 *   1. Fetch sitemap.xml → extract /category/* URLs.
 *   2. Walk each category page list (?page=N) until a page returns zero
 *      products (terminate on card-count, not status — past-end returns 200).
 *   3. Map products via existing toFreshChoiceObservation with the storefront's
 *      store object.
 *   4. Record through PriceArchive as offer revisions only (no snapshotScope).
 *
 * Pacing lives inside the FreshChoiceBreadthClient (delayMs), not in a
 * transport wrapper — the mobile pilot proved wrapper hangs while bare
 * sequential fetches worked.
 *
 * Resume: continuation-page ids checkpointed in <file>.breadth-manifest.json.
 * Discovery (sitemap + category root pages) reruns each run to keep the plan
 * fresh. Delete the manifest to force a full re-crawl.
 */

import { PriceArchive } from "../src/archive.js";
import {
  FreshChoiceClient,
  parseFreshChoiceProducts,
  pageCount,
  toFreshChoiceObservation,
} from "../src/adapters/freshchoice.js";
import {
  FreshChoiceBreadthClient,
  BREAKER_THRESHOLD,
} from "../src/adapters/freshchoice-breadth.js";
import { JsonlObservationRepository } from "../src/repository.js";
import {
  loadManifest,
  saveManifest,
} from "./lib/crawler.js";
import {
  assertNotLiveArchive,
  resolveStores,
} from "./foodstuffs-breadth.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const DEFAULT_FILE = "data/breadth-pilot-fc.jsonl";
export const DEFAULT_DELAY_MS = 3000;
export const DEFAULT_PILOT_BUDGET = 800;
const MANIFEST_SUFFIX = ".breadth-manifest.json";
const MANIFEST_VERSION = 1;

/** Cap on pilot-storefront verification probes per run. */
const PILOT_PROBE_CAP = 12;

// ---- stable task id helpers -----------------------------------------------

/**
 * Stable category task key embedded in manifest ids.
 * @param {string} categoryPath — e.g. "/category/bakery"
 */
export function categoryKey(categoryPath) {
  return `cat=${categoryPath.replace(/^\/category\//, "")}`;
}

/**
 * Stable crawler/manifest task id for one category page.
 * Format: `${slug}:${categoryKey}:page${n}`
 */
export function taskId(slug, categoryPath, page) {
  return `${slug}:${categoryKey(categoryPath)}:page${page}`;
}

// ---- collection ------------------------------------------------------------

/**
 * Absorb freshly-parsed products into the per-store dedup map (keyed by
 * product.id). Returns only first-seen products so callers map observations
 * incrementally.
 */
export function absorbProducts(seen, products) {
  const fresh = [];
  for (const product of products ?? []) {
    const id = product?.id;
    if (id == null || seen.has(id)) continue;
    seen.set(id, product);
    fresh.push(product);
  }
  return fresh;
}

/**
 * Crawl one store's full catalogue via sitemap → category walk.
 *
 * 1. Fetch sitemap.xml → list of /category/* URLs.
 * 2. For each category: fetch page 0, parse card count and max page from
 *    markup; if cards > 0, fetch remaining pages (1..maxPage-1).
 * 3. Terminate a category when a page returns zero ProductCards (past-end).
 * 4. Dedupe by product.id across categories.
 *
 * @param {object} options
 * @param {FreshChoiceBreadthClient} options.client
 * @param {object} options.store — store record with { id, slug, name, origin }
 * @param {string} options.observedAt
 * @param {(observations, continuationIds) => Promise<void>} options.commitWave
 * @param {(want: number) => number} [options.claimBudget]
 * @param {Map<string, string>} [options.completed]
 * @param {(msg: string) => void} [options.log]
 * @param {(msg: string) => void} [options.collectWarning]
 */
export async function crawlStore({
  client,
  store,
  observedAt,
  commitWave,
  claimBudget = (want) => want,
  completed = new Map(),
  log = () => {},
  collectWarning = () => {},
}) {
  const seen = new Map();
  const planned = new Set();
  const warnings = [];
  const warn = (message) => {
    warnings.push(message);
    collectWarning(`${store.name}: ${message}`);
  };
  let pagesFetched = 0;
  const emptyPages = [];

  // Circuit breaker (mirrors foodstuffs-breadth pattern).
  let consecutiveFailures = 0;
  let circuitOpenedAt = null;

  /**
   * Fetch the sitemap, returning sorted /category/* URL paths.
   */
  async function fetchSitemapCategories() {
    return client.fetchSitemap(store.origin);
  }

  /**
   * Fetch one category page, returning parsed products and metadata.
   */
  async function fetchAndParse(categoryPath, page) {
    const html = await client.fetchCategoryPage(
      store.origin,
      categoryPath,
      page,
    );
    const products = parseFreshChoiceProducts(html);
    const maxPage = pageCount(html);
    return { products, maxPage, html };
  }

  /**
   * STRICTLY SEQUENTIAL request execution: one request in flight at a
   * time, processed completion→completion so the client's pacing floor
   * holds between every dispatch (waves + Promise.all bypassed it), the
   * circuit breaker counts true consecutive failures in completion order,
   * and an empty page terminates a category lazily — continuations are
   * spawned ONE PAGE AHEAD, never batched, so nothing beyond catalogue
   * end is ever requested.
   */
  async function runWave(thunks) {
    const spawned = [];
    const observations = [];
    const continuationIds = [];
    let budgetStop = false;

    let index = 0;
    while (index < thunks.length) {
      // Budget admission happens per request, exactly when it goes out.
      if (claimBudget(1) <= 0) {
        budgetStop = true;
        return {
          spawned,
          carried: thunks.slice(index),
          budgetStop,
          circuitOpen: circuitOpenedAt !== null,
        };
      }

      const thunk = thunks[index];
      index += 1;
      try {
        const result = await fetchAndParse(thunk.categoryPath, thunk.page);
        consecutiveFailures = 0;
        pagesFetched += 1;
        const { products } = result;

        if (
          thunk.kind === "leaf" &&
          thunk.page >= 1 &&
          products.length === 0
        ) {
          // Past catalogue end: nothing further is spawned for this path.
          emptyPages.push(thunk.id);
          continue;
        }

        const fresh = absorbProducts(seen, products);
        for (const product of fresh) {
          const observation = toFreshChoiceObservation(product, store, {
            observedAt,
            origin: store.origin,
          });
          if (observation) observations.push(observation);
        }
        log(
          `${thunk.id}: +${fresh.length} new (${seen.size} unique, ` +
            `${observations.length} priced this crawl)`,
        );

        const nextPage = thunk.page + 1;
        const hasNext =
          thunk.maxPage === undefined || nextPage < thunk.maxPage;

        if (thunk.kind === "drill") {
          if (result.maxPage > 1 && products.length > 0) {
            const id = taskId(store.slug, thunk.categoryPath, 1);
            if (!completed.has(id) && !planned.has(id)) {
              planned.add(id);
              spawned.push({
                kind: "leaf",
                id,
                categoryPath: thunk.categoryPath,
                page: 1,
                maxPage: result.maxPage,
              });
            }
          }
        } else if (thunk.kind === "leaf" && hasNext) {
          const id = taskId(store.slug, thunk.categoryPath, nextPage);
          if (!completed.has(id) && !planned.has(id)) {
            planned.add(id);
            spawned.push({
              kind: "leaf",
              id,
              categoryPath: thunk.categoryPath,
              page: nextPage,
              maxPage: thunk.maxPage,
            });
          }
        }

        // Only committed continuation pages checkpoint; discovery reruns.
        if (thunk.kind === "leaf" && thunk.page >= 1) {
          continuationIds.push(thunk.id);
        }
      } catch (error) {
        if (error?.code === "EBREADTHBUDGET") {
          budgetStop = true;
          return {
            spawned,
            carried: thunks.slice(index - 1),
            budgetStop,
            circuitOpen: circuitOpenedAt !== null,
          };
        }
        consecutiveFailures += 1;
        warn(`${thunk.id} failed: ${error?.message ?? String(error)}`);
        if (consecutiveFailures >= BREAKER_THRESHOLD) {
          circuitOpenedAt = thunk.id;
          warn(
            `circuit opened after ${BREAKER_THRESHOLD} consecutive failed ` +
              `requests — aborting; resume from the manifest later.`,
          );
          return {
            spawned,
            carried: [],
            budgetStop,
            circuitOpen: true,
          };
        }
      }
    }

    await commitWave(observations, continuationIds);
    return { spawned, carried: [], budgetStop, circuitOpen: circuitOpenedAt !== null };
  }

  // ---- entry point -------------------------------------------------------

  const categoryUrls = await fetchSitemapCategories();
  log(
    `${store.name}: sitemap has ${categoryUrls.length} category URLs`,
  );

  // Seed initial wave with each category page 0.
  const initial = [];
  for (const url of categoryUrls) {
    const path = new URL(url).pathname;
    const id = taskId(store.slug, path, 0);
    planned.add(id);
    initial.push({
      kind: "drill",
      id,
      categoryPath: path,
      page: 0,
    });
  }
  log(
    `${store.name}: seeded ${initial.length} initial category tasks`,
  );

  let pending = initial;
  let budgetExhausted = false;
  let circuitError;

  while (pending.length > 0) {
    const wave = await runWave(pending);
    if (wave.budgetStop) {
      budgetExhausted = true;
      warn(
        "request budget exhausted before the catalogue was fully crawled",
      );
      break;
    }
    if (wave.circuitOpen) {
      circuitError =
        `circuit opened after ${BREAKER_THRESHOLD} consecutive failed ` +
        `requests (first: ${circuitOpenedAt}) — the API is blocking this ` +
        `client; aborting the run. Resume from the manifest after a ` +
        `cooldown (suggest ≥30 min), then re-run with wider --delay-ms.`;
      warn(circuitError);
      break;
    }
    pending = wave.spawned.concat(wave.carried);
  }

  return {
    store,
    retailer: "freshchoice",
    uniqueCount: seen.size,
    pagesFetched,
    emptyPages,
    sitemapCategories: categoryUrls.length,
    warnings,
    budgetExhausted,
    ...(circuitError ? { error: circuitError } : {}),
  };
}

/**
 * Verify a storefront is crawlable by probing its sitemap. Returns the
 * store if it responds with ≥1 category URL, null if not.
 */
async function probeStorefront(store, client) {
  try {
    const urls = await client.fetchSitemap(store.origin);
    return urls.length > 0 ? store : null;
  } catch {
    return null;
  }
}

/**
 * Pick the first alphabetically-sorted storefront whose sitemap responds
 * with at least one category URL. Logs skipped storefronts as
 * non-crawlable. Caps attempts at PILOT_PROBE_CAP.
 */
export async function pickCrawlableStore(stores, client, log) {
  const sorted = [...stores].sort((a, b) =>
    a.name.localeCompare(b.name, "en-NZ"),
  );
  let attempts = 0;
  for (const candidate of sorted) {
    if (attempts >= PILOT_PROBE_CAP) break;
    attempts += 1;
    const result = await probeStorefront(candidate, client);
    if (result) {
      log(`Pilot selected: ${result.name} (verified crawlable)`);
      return result;
    }
    log(`Pilot skipped ${candidate.name}: not crawlable (sitemap unreachable or empty)`);
  }
  throw new Error("No crawlable storefront found among all FreshChoice stores");
}

// ---- orchestration --------------------------------------------------------

/**
 * Parse CLI argv into options.
 */
export function parseArgs(argv) {
  const options = {
    storeQueries: [],
    file: DEFAULT_FILE,
    delayMs: DEFAULT_DELAY_MS,
    budget: DEFAULT_PILOT_BUDGET,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) {
        throw new TypeError(`${arg} requires a value`);
      }
      return argv[index];
    };
    switch (arg) {
      case "--store":
        options.storeQueries.push(value());
        break;
      case "--file":
        options.file = value();
        break;
      case "--delay-ms":
        options.delayMs = Number(value());
        break;
      case "--budget":
        options.budget = Number(value());
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new TypeError(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    throw new TypeError("--delay-ms must be a non-negative number");
  }
  if (!Number.isInteger(options.budget) || options.budget < 1) {
    throw new TypeError("--budget must be a positive integer");
  }
  return options;
}

/**
 * Run a FreshChoice breadth collection.
 */
export async function runCollection(options = {}) {
  const {
    storeQueries = [],
    file = DEFAULT_FILE,
    delayMs = DEFAULT_DELAY_MS,
    budget = DEFAULT_PILOT_BUDGET,
    transport = globalThis.fetch,
    observedAt = new Date().toISOString(),
    clock = () => new Date(),
    log = () => {},
    collectWarning = (message) => console.error(`warn: ${message}`),
  } = options;

  assertNotLiveArchive(file, { forceLive: false });
  const manifestPath = `${resolve(file)}${MANIFEST_SUFFIX}`;

  // Wire-request counter shared across all transports (store list, sitemap,
  // category pages — all counted against the same budget).
  let wireRequests = 0;
  const countingTransport = async (url, init) => {
    wireRequests += 1;
    return transport(url, init);
  };

  // Single intentional FreshChoiceBreadthClient per run (finding 6).
  const client = new FreshChoiceBreadthClient({
    fetch: countingTransport,
    delayMs,
  });

  // Resolve stores. listStores() goes through countingTransport (finding 4).
  const fcClient = new FreshChoiceClient({ fetch: countingTransport });
  const allStores = await fcClient.listStores();
  if (!Array.isArray(allStores) || allStores.length === 0) {
    throw new Error("No FreshChoice stores returned by the store list API");
  }

  const stores =
    storeQueries.length > 0
      ? resolveStores(storeQueries, allStores)
      : [await pickCrawlableStore(allStores, client, log)];

  // Resume state.
  const stored = await loadManifest(manifestPath);
  const completed = new Map(Object.entries(stored?.completed ?? {}));
  const persistManifest = () =>
    saveManifest(manifestPath, {
      version: MANIFEST_VERSION,
      updatedAt: new Date().toISOString(),
      completed: Object.fromEntries(completed),
    });

  const archive = new PriceArchive(
    new JsonlObservationRepository(file),
    { clock },
  );
  let addedTotal = 0;
  let manifestPersistFailures = 0;

  const commitWave = async (observations, continuationIds) => {
    if (observations.length > 0) {
      addedTotal += await archive.record(observations);
    }
    const now = new Date().toISOString();
    for (const id of continuationIds) completed.set(id, now);
    if (continuationIds.length > 0) {
      try {
        await persistManifest();
      } catch (error) {
        manifestPersistFailures += 1;
        collectWarning(
          `manifest persist failed (${continuationIds.length} page(s) ` +
            `will re-crawl next run): ${error.message}`,
        );
      }
    }
  };

  const claimBudget = (want) =>
    Math.max(0, Math.min(want, budget - wireRequests));

  log(
    `freshchoice-breadth: ${stores.map((s) => s.name).join(", ")} → ${file}`,
  );

  const storeResults = [];

  for (const store of stores) {
    try {
      const result = await crawlStore({
        client,
        store,
        observedAt,
        commitWave,
        claimBudget,
        completed,
        log,
        collectWarning,
      });
      storeResults.push(result);
    } catch (error) {
      collectWarning(`${store.name}: crawl aborted: ${error.message}`);
      storeResults.push({
        store,
        retailer: "freshchoice",
        uniqueCount: 0,
        pagesFetched: 0,
        sitemapCategories: 0,
        warnings: [`crawl aborted: ${error.message}`],
        budgetExhausted: false,
        error: error.message,
      });
    }
  }

  const unhealthy =
    storeResults.some(
      (result) => result.budgetExhausted || result.error,
    ) || manifestPersistFailures > 0;

  const summary = {
    file,
    manifestPath,
    observedAt,
    healthy: !unhealthy,
    manifestPersistFailures,
    stores: storeResults.map((result) => ({
      retailer: result.retailer,
      id: result.store.id,
      name: result.store.name,
      uniqueProducts: result.uniqueCount,
      pagesFetched: result.pagesFetched,
      sitemapCategories: result.sitemapCategories,
      emptyPages: result.emptyPages,
      budgetExhausted: result.budgetExhausted,
      ...(result.error ? { error: result.error } : {}),
      warnings: result.warnings,
    })),
    observationsRecorded: addedTotal,
    httpRequestsAdmitted: wireRequests,
  };
  return summary;
}

// ---- CLI -----------------------------------------------------------------

function printHelp() {
  console.log(`Usage:
  node scripts/freshchoice-breadth.js [--store <id-or-name>]...
      [--file <jsonl>] [--delay-ms N] [--budget N]

FreshChoice full-catalogue breadth collector (BREADTH-2). Per store: fetch
sitemap.xml, walk every /category/* page list, terminate on zero-card pages.
Products are deduped by product.id across overlapping categories. Records
offer revisions only (no snapshotScope).

Pilot default: the first store alphabetically (e.g. Avondale).

Options:
  --store <value>  store slug or name fragment; repeatable. Omit for pilot.
  --file <path>    archive to append offer revisions to
                   (default: ${DEFAULT_FILE})
  --delay-ms N     minimum gap between requests (default: ${DEFAULT_DELAY_MS})
  --budget N       hard cap on HTTP calls this run (default ${DEFAULT_PILOT_BUDGET})

Resume: continuation pages checkpointed in <file>.breadth-manifest.json;
re-running skips recorded pages. Discovery requests rerun each run.`);
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [firstArg] = process.argv.slice(2);
  if (firstArg === "--help" || firstArg === "-h") {
    printHelp();
  } else {
    try {
      const parsed = parseArgs(process.argv.slice(2));
      const summary = await runCollection({
        ...parsed,
        log: (message) => console.log(message),
      });
      console.log(JSON.stringify(summary, null, 2));
      if (!summary.healthy) process.exitCode = 1;
    } catch (error) {
      console.error(`error: ${error.message}`);
      console.error("Run with --help for usage.");
      process.exitCode = 1;
    }
  }
}