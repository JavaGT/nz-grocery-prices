#!/usr/bin/env node
/**
 * BREADTH-1 (mobile pivot) — Foodstuffs full-catalogue breadth collector
 * using the mobile app backend.
 *
 * Instead of Algolia facet-driven discovery, the planner starts from the
 * category tree (one GET) and walks every top-level node. Nodes that
 * saturate the 1,000-hit pagination clamp drill into their tree children
 * (depth max cat2). Leaves are paginated fully.
 *
 * No reconciliation target exists (mobile API lacks tobacco:false facets).
 * Completeness = every tree leaf crawled. Clamp-saturated nodes warn.
 *
 * Records through PriceArchive.record as offer revisions only (no
 * snapshotScope). Resume via checkpointed continuation pages.
 *
 * Requests flow through scripts/lib/crawler.js via the same bridge pattern
 * as foodstuffs-breadth.js — the injected fetch is the crawler bridge, so
 * every HTTP call (auth included) becomes a crawler task sharing one
 * per-host pacing slot.
 */

import { PriceArchive } from "../src/archive.js";
import {
  MobileFoodstuffsClient,
  toPriceObservation,
} from "../src/adapters/foodstuffs-mobile.js";
import { JsonlObservationRepository } from "../src/repository.js";
import {
  OUTCOME_CATEGORIES,
  createCrawler,
  loadManifest,
  saveManifest,
} from "./lib/crawler.js";
import {
  absorbHits,
  assertNotLiveArchive,
  DEFAULT_PILOT_BUDGET,
  reconcile,
  resolveStores,
} from "./foodstuffs-breadth.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const { BUDGET_SKIPPED } = OUTCOME_CATEGORIES;

export const DEFAULT_DELAY_MS = 5000;
export const DEFAULT_FILE = "data/breadth-pilot.jsonl";
export const BREAKER_THRESHOLD = 5;
const MANIFEST_SUFFIX = ".breadth-manifest.json";
const MANIFEST_VERSION = 1;
const HIT_CLAMP = 1000;
const MAX_TREE_DEPTH = 2; // cat0, cat1, cat2

// ---- stable task id helpers (mobile-specific prefix "mcat") --------------

/**
 * Category key embedded in mobile task ids:
 *   "mcat=cat0=<name>" | "mcat=cat0=<name>|cat1=<child>" | "mcat=cat0=<name>|cat1=<child>|cat2=<gc>"
 */
export function mobileKey(categoryPath) {
  const levels = ["cat0", "cat1", "cat2"];
  return categoryPath
    .map((value, index) => `${levels[index]}=${value}`)
    .join("|");
}

/** Stable crawler/manifest task id for one mobile category page. */
export function taskId(storeId, categoryPath, page) {
  return `${storeId}:mcat=${mobileKey(categoryPath)}:page${page}`;
}

/**
 * Build a query-string path suffix for the categoryPage call from a
 * categoryPath array [name] / [name, child] / [name, child, grandchild].
 */
export function categoryPathParams(categoryPath) {
  return {
    cat0: categoryPath[0],
    ...(categoryPath[1] !== undefined ? { cat1: categoryPath[1] } : {}),
    ...(categoryPath[2] !== undefined ? { cat2: categoryPath[2] } : {}),
  };
}

/**
 * Walk the tree to find children of a node identified by its category path.
 * Returns [] if the node has no children or the path doesn't exist.
 */
export function treeNodeChildren(tree, categoryPath) {
  let nodes = tree;
  for (const segment of categoryPath) {
    if (!Array.isArray(nodes)) return [];
    const found = nodes.find((n) => n.name === segment);
    if (!found) return [];
    nodes = found.children;
  }
  return Array.isArray(nodes) ? nodes : [];
}

/**
 * Flatten the tree to a list of { path, name } for every leaf at or before
 * MAX_TREE_DEPTH (cat2). Top-level nodes with children are NOT leaves — they
 * may be expanded if saturated.
 */
export function flattenTreeLeaves(tree) {
  const leaves = [];
  function walk(node, depth, path) {
    const currentPath = [...path, node.name];
    if (depth >= MAX_TREE_DEPTH || !node.children || node.children.length === 0) {
      leaves.push({ path: currentPath, name: node.name });
    } else {
      for (const child of node.children) {
        walk(child, depth + 1, currentPath);
      }
    }
  }
  for (const node of tree) {
    walk(node, 0, []);
  }
  return leaves;
}

/**
 * Check if a category-page response saturates the 1,000-hit clamp.
 * When true, we must drill into tree children to reach the full catalogue.
 */
export function isSaturated(envelope) {
  return (envelope?.totalHits ?? 0) >= HIT_CLAMP;
}

/**
 * Derive continuation pages (1..numberOfPages-1) from a leaf's response
 * envelope. Returns empty array when the envelope represents a single page.
 */
export function continuationPages(envelope) {
  const totalPages = envelope?.numberOfPages ?? 1;
  const pages = [];
  for (let page = 1; page < totalPages; page += 1) pages.push(page);
  return pages;
}

// ---- crawler bridge (same pattern as foodstuffs-breadth.js) ---------------

function budgetError(limit) {
  const error = new Error(
    `breadth request budget exhausted (limit ${limit}); ` +
      "remaining work was left un-done for the next run",
  );
  error.code = "EBREADTHBUDGET";
  return error;
}

export function createCrawlerBridge({ crawler, budget = Number.POSITIVE_INFINITY } = {}) {
  if (!crawler || typeof crawler.run !== "function") {
    throw new TypeError("createCrawlerBridge requires a crawler from createCrawler()");
  }
  const queue = [];
  let admitted = 0;
  let anonCounter = 0;
  let draining = null;

  async function drain() {
    while (queue.length > 0) {
      const room = Math.max(0, budget - admitted);
      const batch = queue.splice(0, room);
      if (batch.length === 0) {
        for (const entry of queue.splice(0)) entry.reject(budgetError(budget));
        continue;
      }
      admitted += batch.length;
      const tasks = batch.map((entry) => ({
        id: entry.id ?? `anon-${(anonCounter += 1)}`,
        url: entry.url,
        init: entry.init,
      }));
      const { results } = await crawler.run(tasks);
      results.forEach((outcome, index) => {
        const entry = batch[index];
        if (outcome.ok && outcome.response) {
          entry.resolve(outcome.response);
        } else if (outcome.category === BUDGET_SKIPPED) {
          entry.reject(budgetError(budget));
        } else {
          entry.reject(
            new Error(
              `breadth request failed (${outcome.category}): ${entry.url}`,
              { cause: outcome.error },
            ),
          );
        }
      });
    }
  }

  function pump() {
    if (draining) return;
    draining = drain().finally(() => {
      draining = null;
      if (queue.length > 0) pump();
    });
  }

  function fetch(url, init) {
    return new Promise((resolveEntry, rejectEntry) => {
      queue.push({
        url: String(url),
        init: init ?? {},
        resolve: resolveEntry,
        reject: rejectEntry,
      });
      pump();
    });
  }

  return { fetch, admittedCount: () => admitted };
}

// ---- collection ----------------------------------------------------------

/**
 * Crawl one store's full catalogue via the mobile API.
 *
 * 1. Fetch the category tree.
 * 2. For every top-level node: fetch page 0.
 *    - If saturated (totalHits >= 1000): drill into tree children.
 *    - Otherwise: paginate fully (leaf).
 * 3. For saturated cat1 children with tree grandchildren: drill to cat2.
 * 4. cat2 is max depth — always paginated fully.
 * 5. Dedupe by productId across overlapping categories.
 *
 * @param {object} options
 * @param {MobileFoodstuffsClient} options.client
 * @param {object} options.store
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

  // Circuit breaker (same pattern as foodstuffs-breadth).
  let consecutiveFailures = 0;
  let circuitOpenedAt = null;

  /**
   * Fetch the category tree for this store. Region defaults to NI; the
   * store object may carry a region field.
   */
  async function fetchTree() {
    const tree = await client.categoryTree(store.id, {
      region: store.region ?? "NI",
    });
    if (!Array.isArray(tree) || tree.length === 0) {
      throw new Error(`Category tree for ${store.id} is empty or not an array`);
    }
    return tree;
  }

  /**
   * Fetch one page from a category, returning the envelope.
   */
  async function fetchPage(categoryPath, page) {
    return client.categoryPage({
      storeId: store.id,
      ...categoryPathParams(categoryPath),
      page,
    });
  }

  /**
   * Run one wave of planned requests. Thunk kinds:
   *   "top"     — top-level cat0 page 0 (from tree)
   *   "drill"   — cat1 or cat2 page 0 (drill-down into tree children)
   *   "leaf"    — continuation page (page >= 1)
   */
  async function runWave(thunks) {
    const granted = claimBudget(thunks.length);
    if (granted <= 0) return { spawned: [], carried: thunks, budgetStop: true };
    const batch = thunks.slice(0, granted);
    const carried = thunks.slice(granted);

    const settled = await Promise.allSettled(
      batch.map((thunk) =>
        fetchPage(thunk.categoryPath, thunk.page).then((envelope) => ({
          thunk,
          envelope,
        })),
      ),
    );

    const spawned = [];
    const observations = [];
    const continuationIds = [];
    let budgetStop = false;

    for (const [index, result] of settled.entries()) {
      const thunk = batch[index];
      if (result.status === "rejected") {
        if (result.reason?.code === "EBREADTHBUDGET") budgetStop = true;
        consecutiveFailures += 1;
        warn(`${thunk.id} failed: ${result.reason?.message ?? String(result.reason)}`);
        if (consecutiveFailures >= BREAKER_THRESHOLD) {
          circuitOpenedAt = thunk.id;
        }
        continue;
      }
      consecutiveFailures = 0;
      const { envelope } = result.value;
      pagesFetched += 1;

      // Empty continuation page beyond catalogue end.
      if (
        thunk.kind === "leaf" &&
        thunk.page >= 1 &&
        (envelope.products?.length ?? 0) === 0
      ) {
        emptyPages.push(thunk.id);
        warn(`${thunk.id}: page beyond catalogue end (0 hits)`);
      }

      const fresh = absorbHits(seen, envelope.products);
      for (const product of fresh) {
        const observation = toPriceObservation(product, store, {
          retailer: client.retailer,
          observedAt,
        });
        if (observation) observations.push(observation);
      }
      log(
        `${thunk.id}: +${fresh.length} new (${seen.size} unique, ` +
          `${observations.length} priced this crawl)`,
      );

      if (thunk.kind === "top" || thunk.kind === "drill") {
        // Page 0 of a category: decide whether to drill down or paginate.
        if (isSaturated(envelope) && thunk.treeChildren?.length > 0) {
          // Saturated: drill into tree children at the next depth level.
          const nextDepth = thunk.categoryPath.length; // 1 for cat0->cat1, 2 for cat1->cat2
          for (const child of thunk.treeChildren) {
            const childPath = [...thunk.categoryPath, child.name];
            const childId = `${store.id}:mcat=${mobileKey(childPath)}:page0`;
            // Pre-mark as planned so we never spawn a duplicate.
            planned.add(childId);
            spawned.push({
              kind: "drill",
              id: childId,
              categoryPath: childPath,
              page: 0,
              treeChildren: nextDepth < MAX_TREE_DEPTH
                ? (child.children ?? [])
                : [],
            });
          }
          warn(
            `${thunk.id} saturates the clamp (${envelope.totalHits} hits); ` +
              `drilling into ${thunk.treeChildren.length} child categories`,
          );
        } else {
          // Not saturated or no children: this node is a leaf → paginate.
          const pages = continuationPages(envelope);
          for (const page of pages) {
            const id = taskId(store.id, thunk.categoryPath, page);
            if (!completed.has(id) && !planned.has(id)) {
              planned.add(id);
              spawned.push({
                kind: "leaf",
                id,
                categoryPath: thunk.categoryPath,
                page,
              });
            }
          }
        }
      } else if (thunk.kind === "leaf" && thunk.page >= 1) {
        // Continuation pages checkpoint in the manifest.
        continuationIds.push(thunk.id);
      }
    }

    await commitWave(observations, continuationIds);
    return { spawned, carried, budgetStop, circuitOpen: circuitOpenedAt !== null };
  }

  // ---- entry point -------------------------------------------------------

  const tree = await fetchTree();
  log(`${store.name}: tree has ${tree.length} top-level categories`);

  // Seed initial wave with all top-level categories from the tree.
  const initial = tree.map((node) => {
    const path = [node.name];
    const id = taskId(store.id, path, 0);
    return {
      kind: "top",
      id,
      categoryPath: path,
      page: 0,
      treeChildren: node.children ?? [],
    };
  });

  let pending = initial;
  let budgetExhausted = false;
  let circuitError;

  while (pending.length > 0) {
    const wave = await runWave(pending);
    if (wave.budgetStop) {
      budgetExhausted = true;
      warn("request budget exhausted before the catalogue was fully crawled");
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

  // Summary — no reconciliation target in mobile API.
  return {
    store,
    retailer: client.retailer,
    uniqueCount: seen.size,
    pagesFetched,
    emptyPages,
    treeCategories: tree.length,
    warnings,
    budgetExhausted,
    ...(circuitError ? { error: circuitError } : {}),
  };
}

// ---- orchestration -------------------------------------------------------

/**
 * Parse CLI argv into options. Same flags as foodstuffs-breadth.js but with
 * delay-ms default 5000.
 */
export function parseArgs(argv) {
  const options = {
    retailer: "paknsave",
    storeQueries: [],
    file: DEFAULT_FILE,
    delayMs: DEFAULT_DELAY_MS,
    budget: DEFAULT_PILOT_BUDGET,
    forceLive: false,
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
      case "--retailer":
        options.retailer = value();
        break;
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
      case "--force-live":
        options.forceLive = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new TypeError(`Unknown argument: ${arg}`);
    }
  }
  if (!["paknsave", "newworld"].includes(options.retailer)) {
    throw new TypeError("--retailer must be paknsave or newworld");
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
 * Run a mobile breadth collection.
 */
export async function runCollection(options = {}) {
  const {
    retailer = "paknsave",
    storeQueries = [],
    file = DEFAULT_FILE,
    delayMs = DEFAULT_DELAY_MS,
    budget = DEFAULT_PILOT_BUDGET,
    forceLive = false,
    transport = globalThis.fetch,
    storesByRetailer = null,
    observedAt = new Date().toISOString(),
    clock = () => new Date(),
    log = () => {},
    collectWarning = (message) => console.error(`warn: ${message}`),
  } = options;

  assertNotLiveArchive(file, { forceLive });
  const manifestPath = `${resolve(file)}${MANIFEST_SUFFIX}`;

  const crawler = createCrawler({
    fetch: transport,
    minHostDelayMs: delayMs,
    budget,
  });
  const bridge = createCrawlerBridge({ crawler, budget });
  const client = new MobileFoodstuffsClient({
    banner: retailer === "newworld" ? "MNW" : "PNS",
    fetch: bridge.fetch,
  });

  // Resolve stores.
  let stores;
  if (storesByRetailer) {
    stores = storesByRetailer;
  } else {
    const all = await client.listStores();
    if (!Array.isArray(all) || all.length === 0) {
      throw new Error(`No ${retailer} stores returned by the store list API`);
    }
    stores = storeQueries.length > 0
      ? resolveStores(storeQueries, all)
      : [[...all].sort((a, b) => a.name.localeCompare(b.name, "en-NZ"))[0]];
  }

  // Resume state.
  const stored = await loadManifest(manifestPath);
  const completed = new Map(Object.entries(stored?.completed ?? {}));
  const persistManifest = () =>
    saveManifest(manifestPath, {
      version: MANIFEST_VERSION,
      updatedAt: new Date().toISOString(),
      completed: Object.fromEntries(completed),
    });

  const archive = new PriceArchive(new JsonlObservationRepository(file), { clock });
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
    Math.max(0, Math.min(want, budget - bridge.admittedCount()));

  log(
    `foodstuffs-mobile-breadth: ${Array.isArray(stores) ? stores.map((s) => s.name).join(", ") : stores.name} → ${file}`,
  );

  const storeList = Array.isArray(stores) ? stores : [stores];
  const storeResults = [];

  for (const store of storeList) {
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
        retailer: client.retailer,
        uniqueCount: 0,
        pagesFetched: 0,
        treeCategories: 0,
        warnings: [`crawl aborted: ${error.message}`],
        budgetExhausted: false,
        error: error.message,
      });
    }
  }

  const unhealthy =
    storeResults.some((result) => result.budgetExhausted || result.error) ||
    manifestPersistFailures > 0;

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
      treeCategories: result.treeCategories,
      emptyPages: result.emptyPages,
      budgetExhausted: result.budgetExhausted,
      ...(result.error ? { error: result.error } : {}),
      warnings: result.warnings,
    })),
    observationsRecorded: addedTotal,
    httpRequestsAdmitted: bridge.admittedCount(),
  };
  return summary;
}

// ---- CLI -----------------------------------------------------------------

function printHelp() {
  console.log(`Usage:
  node scripts/foodstuffs-mobile-breadth.js [--retailer paknsave|newworld]
      [--store <id-or-name>]... [--file <jsonl>] [--delay-ms N] [--budget N]

Foodstuffs full-catalogue breadth collector using the mobile app backend
(BREADTH-1 mobile pivot). Per store: fetch the category tree, then walk
every top-level node. Nodes saturating the 1,000-hit pagination clamp drill
into tree children (depth max cat2). Leaves are paginated fully. Products
are deduped by productId across overlapping categories.

Options:
  --retailer <name>  paknsave or newworld (default: paknsave)
  --store <value>    store UUID or name fragment; repeatable.
  --file <path>      archive to append offer revisions to
                     (default: ${DEFAULT_FILE})
  --delay-ms N       minimum gap between requests to the same host
                     (default: ${DEFAULT_DELAY_MS})
  --budget N         hard cap on HTTP calls this run (auth included);
                     default ${DEFAULT_PILOT_BUDGET}
  --force-live       DANGEROUS: allow --file to point at the live archive

Resume: continuation pages are checkpointed in <file>.breadth-manifest.json
after their records are appended; re-running skips recorded pages. Discovery
requests rerun each time to keep the facet plan fresh.`);
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [firstArg] = process.argv.slice(2);
  if (firstArg === "--help" || firstArg === "-h") {
    printHelp();
  } else {
    try {
      const options = parseArgs(process.argv.slice(2));
      const summary = await runCollection({
        ...options,
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