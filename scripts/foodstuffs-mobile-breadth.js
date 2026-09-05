#!/usr/bin/env node
/**
 * BREADTH-1 (mobile pivot) — Foodstuffs full-catalogue breadth collector
 * using the mobile app backend.
 *
 * Instead of Algolia facet-driven discovery, the planner starts from the
 * category tree (one GET) and walks every node at arbitrary depth.
 * Nodes that saturate the 1,000-hit pagination clamp drill into tree
 * children (cat1, cat2 — the API supports cat0/cat1/cat2 query params).
 * Beyond cat2 the API cannot express deeper names, so saturated nodes
 * at depth 2 (or childless saturated nodes at any depth) are marked as
 * incomplete coverage rather than silently paginated.
 *
 * No reconciliation target exists (mobile API lacks tobacco:false facets).
 * Completeness = every tree leaf crawled; clamp-saturated nodes that
 * cannot be refined emit warnings and set incompleteCoverage on the
 * per-store result.
 *
 * Records through PriceArchive.record as offer revisions only (no
 * snapshotScope). Resume via checkpointed continuation pages.
 *
 * Requests are paced INSIDE MobileFoodstuffsClient (delayMs) and flow
 * over a bare injected transport — see the transport note in runCollection.
 * as scripts/lib/breadth-helpers.js — the injected fetch is the crawler bridge, so
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
  withRetryRounds,
} from "./lib/crawler.js";
import {
  DEFAULT_DISCOVERY_TTL_MS,
  absorbHits,
  assertNotLiveArchive,
  DEFAULT_PILOT_BUDGET,
  discoveryFresh,
  reconcile,
  resolveStores,
} from "./lib/breadth-helpers.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const { BUDGET_SKIPPED } = OUTCOME_CATEGORIES;

export const DEFAULT_DELAY_MS = 5000;
export const DEFAULT_FILE = "data/breadth-pilot.jsonl";
export const BREAKER_THRESHOLD = 5;
// Nightly health floor: pilot nights collect 11k-13k products per banner;
// anything under this means the crawl is failing to see the catalogue.
export const DEFAULT_MIN_EXPECTED_PRODUCTS = 1000;
// Bootstrap fetches (store list, category tree) get walker-level retry
// rounds ON TOP of the client's per-request retries: a stretch of 5xx
// from Foodstuffs must not abort the whole nightly lane (the Sep-5 pilot
// night lost paknsave to one persistent 500 on the tree endpoint).
export const DEFAULT_BOOTSTRAP_ROUNDS = 3;
export const DEFAULT_BOOTSTRAP_GAP_MS = 10_000;
const MANIFEST_SUFFIX = ".breadth-manifest.json";
const MANIFEST_VERSION = 1;
const HIT_CLAMP = 1000;

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
 * Flatten the tree to a list of { path, name } for every leaf (terminal
 * node with no children), regardless of depth.
 */
export function flattenTreeLeaves(tree) {
  const leaves = [];
  function walk(node, depth, path) {
    const currentPath = [...path, node.name];
    if (!node.children || node.children.length === 0) {
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
 * Walk the full tree at arbitrary depth and produce a flat array of plan
 * objects.  Only nodes at depth 0..2 are expressible via cat0/cat1/cat2
 * query params; deeper nodes are recorded as saturationChildren of their
 * parent (depth-2) node so the crawl can detect unreachable sub-categories.
 *
 * @param {Array} tree — category tree array from the API
 * @returns {Array<{path:string[], depth:number, treeChildren:Array,
 *                   saturationChildren:Array}>}
 */
export function buildTreePlans(tree) {
  const plans = [];

  function walk(node, depth, path) {
    const currentPath = [...path, node.name];
    // Every node gets a plan (for completeness tracking even if depth > 2 is
    // not directly queryable — its parent carries it as saturationChildren).
    plans.push({
      path: currentPath,
      depth,
      // Children at depth < 2 are drillable (expressible as cat1/cat2).
      treeChildren:
        depth < 2 && Array.isArray(node.children) ? node.children : [],
      // Children at depth >= 2 are unreachable via the API's cat0-2 scheme.
      saturationChildren:
        depth >= 2 && Array.isArray(node.children) ? node.children : [],
    });

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        walk(child, depth + 1, currentPath);
      }
    }
  }

  for (const node of tree) {
    walk(node, 0, []);
  }

  return plans;
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
 * envelope.  Throws TypeError if numberOfPages is missing or non-numeric.
 */
export function continuationPages(envelope, label = "") {
  const { numberOfPages } = envelope ?? {};
  if (typeof numberOfPages !== "number" || !Number.isFinite(numberOfPages)) {
    throw new TypeError(
      `Missing or non-numeric numberOfPages in page envelope${label ? ` (${label})` : ""}`,
    );
  }
  const pages = [];
  for (let page = 1; page < numberOfPages; page += 1) pages.push(page);
  return pages;
}

// ---- crawler bridge (same pattern as scripts/lib/crawler.js) --------------

function budgetError(limit) {
  const error = new Error(
    `breadth request budget exhausted (limit ${limit}); ` +
      "remaining work was left un-done for the next run",
  );
  error.code = "EBREADTHBUDGET";
  return error;
}

export function createCrawlerBridge({
  crawler,
  budget = Number.POSITIVE_INFINITY,
} = {}) {
  if (!crawler || typeof crawler.run !== "function") {
    throw new TypeError(
      "createCrawlerBridge requires a crawler from createCrawler()",
    );
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
 * 1. Fetch the category tree, build plans for every node at arbitrary depth.
 * 2. For every expressible node (depth 0..2): fetch page 0.
 *    - If saturated AND has drillable children (depth < 2): drill into them.
 *    - If saturated AND no drillable children (depth >= 2 or childless):
 *      mark as incompleteCoverage — the clamp prevents a complete fetch.
 *    - Otherwise (not saturated): paginate fully (leaf).
 * 3. Dedupe by productId across overlapping categories.
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
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {number} [options.bootstrapRounds]
 * @param {number} [options.bootstrapGapMs]
 */
export async function crawlStore({
  client,
  store,
  observedAt,
  commitWave,
  claimBudget = (want) => want,
  completed = new Map(),
  forceDiscovery = false,
  discoveryTtlMs = DEFAULT_DISCOVERY_TTL_MS,
  log = () => {},
  collectWarning = () => {},
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  bootstrapRounds = DEFAULT_BOOTSTRAP_ROUNDS,
  bootstrapGapMs = DEFAULT_BOOTSTRAP_GAP_MS,
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
  const doneEmpty = new Set(); // CONCERN 6: category paths that ended early
  const incompleteNodes = [];  // BLOCKER 1+2: saturated non-refinable nodes

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
      throw new Error(
        `Category tree for ${store.id} is empty or not an array`,
      );
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
   *   "drill"   — page 0 of a category node (from tree plans)
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
        warn(
          `${thunk.id} failed: ${result.reason?.message ?? String(result.reason)}`,
        );
        if (consecutiveFailures >= BREAKER_THRESHOLD) {
          circuitOpenedAt = thunk.id;
        }
        continue;
      }
      consecutiveFailures = 0;
      const { envelope } = result.value;
      pagesFetched += 1;

      // Empty continuation page beyond catalogue end (CONCERN 6).
      if (
        thunk.kind === "leaf" &&
        thunk.page >= 1 &&
        (envelope.products?.length ?? 0) === 0
      ) {
        doneEmpty.add(mobileKey(thunk.categoryPath));
        emptyPages.push(thunk.id);
        warn(
          `${thunk.id}: page beyond catalogue end (0 hits) — stopped scheduling further pages for this category`,
        );
        continue; // skip absorb — no products
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

      if (thunk.kind === "drill") {
        // Page 0 of a category: decide whether to drill down or paginate.
        if (isSaturated(envelope)) {
          if (thunk.treeChildren?.length > 0) {
            // Saturated + drillable children → spawn children.
            for (const child of thunk.treeChildren) {
              const childPath = [...thunk.categoryPath, child.name];
              const childId = taskId(store.id, childPath, 0);
              const childDepth = childPath.length - 1; // 0..N
              // Pre-mark as planned so we never spawn a duplicate.
              planned.add(childId);
              spawned.push({
                kind: "drill",
                id: childId,
                categoryPath: childPath,
                page: 0,
                treeChildren:
                  childDepth < 2 ? child.children ?? [] : [],
                saturationChildren:
                  childDepth >= 2 ? child.children ?? [] : [],
              });
            }
            warn(
              `${thunk.id} saturates the clamp (${envelope.totalHits} hits); ` +
                `drilling into ${thunk.treeChildren.length} child categories`,
            );
          } else {
            // Saturated + no drillable children → incomplete coverage.
            // This happens when the node is at depth 2 (cat2, max API
            // expressible depth) or has no children at any depth.
            incompleteNodes.push({
              path: thunk.categoryPath.join("/"),
              depth: thunk.categoryPath.length - 1,
              totalHits: envelope.totalHits,
              saturationChildren: thunk.saturationChildren?.length ?? 0,
            });
            warn(
              `${thunk.id} saturates the clamp (${envelope.totalHits} hits) ` +
                `and cannot be refined further: ` +
                (thunk.saturationChildren?.length > 0
                  ? `${thunk.saturationChildren.length} sub-categories at unreachable depth (cat3+); ` +
                    `coverage is incomplete for this path`
                  : "no child categories to drill into; " +
                    "coverage is incomplete for this path"),
            );
          }
        } else {
          // Not saturated → this node is a leaf: paginate fully.
          const pages = continuationPages(envelope, thunk.id);
          for (const page of pages) {
            const id = taskId(store.id, thunk.categoryPath, page);
            // TTL-aware spawn guard (BREADTH-8): pages crawled within the
            // discovery TTL are skipped; past the TTL they re-fetch so
            // prices and new products on pages >= 1 surface within the TTL.
            if (
              !discoveryFresh(completed, id, observedAt, discoveryTtlMs) &&
              !planned.has(id)
            ) {
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

      // Drill page-0 nodes checkpoint too (BREADTH-8): entries age out after
      // the discovery TTL, so every tree node re-discovers periodically.
      // Crash window: a committed drill whose spawned children/leaves have
      // not committed yet delays their prices until the TTL ages it out —
      // bounded, never lost.
      if (thunk.kind === "drill") {
        continuationIds.push(thunk.id);
      }
    }

    await commitWave(observations, continuationIds);
    return {
      spawned,
      carried,
      budgetStop,
      circuitOpen: circuitOpenedAt !== null,
    };
  }

  // ---- entry point -------------------------------------------------------

  // The tree fetch is a single point of failure for the whole store crawl;
  // give it walker-level retry rounds (with a wider gap than the client's
  // per-request backoff) before giving up and aborting the night.
  const tree = await withRetryRounds(
    () => fetchTree(),
    {
      rounds: bootstrapRounds,
      gapMs: bootstrapGapMs,
      sleep,
      onRetry: (attempt, error) =>
        warn(
          `category tree attempt ${attempt} failed: ${error.message} — ` +
            `retrying (${bootstrapRounds - attempt} round(s) left)`,
        ),
    },
  );
  const plans = buildTreePlans(tree);
  log(
    `${store.name}: tree has ${tree.length} top-level categories, ${plans.length} total nodes`,
  );

  // Seed initial wave with all expressible nodes (depth 0..2), skipping
  // nodes whose page-0 was discovered within the TTL (BREADTH-8). The tree
  // is still fetched every run, so new/removed nodes always crawl;
  // --force-discovery re-seeds everything regardless of the manifest.
  // (CONCERN 5: seed the planned set with initial task ids.)
  // Dedupe by task id (a Map) so duplicate sibling names produce one task.
  const initialMap = new Map();
  let skippedDiscovery = 0;
  for (const plan of plans) {
    if (plan.depth > 2) continue;
    const id = taskId(store.id, plan.path, 0);
    if (
      !forceDiscovery &&
      discoveryFresh(completed, id, observedAt, discoveryTtlMs)
    ) {
      skippedDiscovery += 1;
      continue;
    }
    planned.add(id);
    if (!initialMap.has(id)) {
      initialMap.set(id, {
        kind: "drill",
        id,
        categoryPath: plan.path,
        page: 0,
        treeChildren: plan.treeChildren,
        saturationChildren: plan.saturationChildren,
      });
    }
  }
  const initial = [...initialMap.values()];
  log(
    `${store.name}: seeded ${initial.length} initial category tasks` +
      (skippedDiscovery > 0
        ? ` (${skippedDiscovery} discovered within TTL, skipped)`
        : ""),
  );

  let pending = initial;
  let budgetExhausted = false;
  let circuitError;

  while (pending.length > 0) {
    // CONCERN 6: filter out leaf pages for categories that have already ended.
    pending = pending.filter((t) => {
      if (t.kind === "leaf" && doneEmpty.has(mobileKey(t.categoryPath))) {
        log(
          `${t.id}: skipping — category already ended (empty page detected)`,
        );
        return false;
      }
      return true;
    });
    if (pending.length === 0) break;

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

  // BLOCKER 1+2: mark incomplete coverage when any node was saturated and
  // could not be refined.
  const incompleteCoverage = incompleteNodes.length > 0;

  // Summary — no reconciliation target in mobile API.
  return {
    store,
    retailer: client.retailer,
    uniqueCount: seen.size,
    pagesFetched,
    emptyPages,
    seededDiscovery: initial.length,
    skippedDiscovery,
    treeCategories: tree.length,
    warnings,
    budgetExhausted,
    incompleteCoverage,
    incompleteNodes,
    ...(circuitError ? { error: circuitError } : {}),
  };
}

// ---- orchestration -------------------------------------------------------

/**
 * Parse CLI argv into options. Same flags as the freshchoice collector but with
 * delay-ms default 5000.
 */
export function parseArgs(argv) {
  const options = {
    retailer: "paknsave",
    storeQueries: [],
    file: DEFAULT_FILE,
    delayMs: DEFAULT_DELAY_MS,
    budget: DEFAULT_PILOT_BUDGET,
    minExpectedProducts: DEFAULT_MIN_EXPECTED_PRODUCTS,
    forceDiscovery: false,
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
      case "--min-expected-products":
        options.minExpectedProducts = Number(value());
        break;
      case "--force-discovery":
        options.forceDiscovery = true;
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
  if (
    !Number.isInteger(options.minExpectedProducts) ||
    options.minExpectedProducts < 0
  ) {
    throw new TypeError(
      "--min-expected-products must be a non-negative integer",
    );
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
    minExpectedProducts = DEFAULT_MIN_EXPECTED_PRODUCTS,
    forceDiscovery = false,
    discoveryTtlMs = DEFAULT_DISCOVERY_TTL_MS,
    bootstrapRounds = DEFAULT_BOOTSTRAP_ROUNDS,
    bootstrapGapMs = DEFAULT_BOOTSTRAP_GAP_MS,
    forceLive = false,
    transport = globalThis.fetch,
    storesByRetailer = null,
    observedAt = new Date().toISOString(),
    clock = () => new Date(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = () => {},
    collectWarning = (message) => console.error(`warn: ${message}`),
  } = options;

  assertNotLiveArchive(file, { forceLive });
  const manifestPath = `${resolve(file)}${MANIFEST_SUFFIX}`;

  // Direct transport with client-side pacing: the pilot proved every
  // wrapper-layer (crawler host slots) hung against this backend while
  // bare sequential fetches flowed fine, so pacing lives in the client
  // (delayMs) and the crawl engine stays untouched.
  let wireRequests = 0;
  const client = new MobileFoodstuffsClient({
    banner: retailer === "newworld" ? "MNW" : "PNS",
    fetch: (...args) => {
      wireRequests += 1;
      return transport(...args);
    },
    delayMs,
  });

  // Resolve stores (retryable: a transient 5xx here aborts the lane
  // before any crawling starts).
  let stores;
  if (storesByRetailer) {
    stores = storesByRetailer;
  } else {
    const all = await withRetryRounds(
      () => client.listStores(),
      {
        rounds: bootstrapRounds,
        gapMs: bootstrapGapMs,
        sleep,
        onRetry: (attempt, error) =>
          collectWarning(
            `store list attempt ${attempt} failed: ${error.message} — ` +
              `retrying (${bootstrapRounds - attempt} round(s) left)`,
          ),
      },
    );
    if (!Array.isArray(all) || all.length === 0) {
      throw new Error(
        `No ${retailer} stores returned by the store list API`,
      );
    }
    // Pilot default (and any --store fragment) must resolve to a store the
    // app backend can actually serve: some listed stores are not
    // online-enabled and their category tree returns 500.
    const online = all.filter((store) => store.onlineActive !== false);
    if (online.length === 0) {
      throw new Error(`No online-active ${retailer} stores returned`);
    }
    stores =
      storeQueries.length > 0
        ? resolveStores(storeQueries, online)
        : [
            [...online].sort((a, b) =>
              a.name.localeCompare(b.name, "en-NZ"),
            )[0],
          ];
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
    // Stamp with the run's observedAt so discovery-TTL aging is keyed to
    // observation time (deterministic under an injected clock).
    const now = observedAt;
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
        forceDiscovery,
        discoveryTtlMs,
        log,
        collectWarning,
        sleep,
        bootstrapRounds,
        bootstrapGapMs,
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
        incompleteCoverage: false,
        incompleteNodes: [],
        error: error.message,
      });
    }
  }

  // Strict product floor binds whenever this crawl ran ANY discovery
  // (seededDiscovery > 0): partial-discovery and truncated-tree nights
  // must fail until a complete discovery lands. The exemption is only for
  // pure skip nights (every node fresh, nothing to see): the discovery
  // TTL guarantees a full-coverage night at least every
  // DEFAULT_DISCOVERY_TTL_MS, where a broken catalogue fails the floor and
  // resets the gate streak.
  const unhealthy =
    storeResults.some(
      (result) =>
        result.budgetExhausted ||
        result.error ||
        result.incompleteCoverage ||
        ((result.uniqueCount ?? 0) < minExpectedProducts &&
          !(
            result.skippedDiscovery > 0 && result.seededDiscovery === 0
          )),
    ) || manifestPersistFailures > 0;

  const summary = {
    file,
    manifestPath,
    observedAt,
    healthy: !unhealthy,
    manifestPersistFailures,
    minExpectedProducts,
    stores: storeResults.map((result) => ({
      retailer: result.retailer,
      id: result.store.id,
      name: result.store.name,
      uniqueProducts: result.uniqueCount,
      pagesFetched: result.pagesFetched,
      treeCategories: result.treeCategories,
      seededDiscovery: result.seededDiscovery,
      skippedDiscovery: result.skippedDiscovery,
      emptyPages: result.emptyPages,
      budgetExhausted: result.budgetExhausted,
      incompleteCoverage: result.incompleteCoverage,
      ...(result.incompleteNodes?.length > 0
        ? { incompleteNodes: result.incompleteNodes }
        : {}),
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
  node scripts/foodstuffs-mobile-breadth.js [--retailer paknsave|newworld]
      [--store <id-or-name>]... [--file <jsonl>] [--delay-ms N] [--budget N]

Foodstuffs full-catalogue breadth collector using the mobile app backend
(BREADTH-1 mobile pivot). Per store: fetch the category tree, then walk
every node at arbitrary depth. Nodes saturating the 1,000-hit pagination
clamp drill into tree children (depth max cat2). Beyond cat2, or childless
saturated nodes, produce incomplete-coverage warnings rather than silently
paginating a clamped result. Products are deduped by productId across
overlapping categories.

Options:
  --retailer <name>  paknsave or newworld (default: paknsave)
  --store <value>    store UUID or name fragment; repeatable.
  --file <path>      archive to append offer revisions to
                     (default: ${DEFAULT_FILE})
  --delay-ms N       minimum gap between requests to the same host
                     (default: ${DEFAULT_DELAY_MS})
  --budget N         hard cap on HTTP calls this run (auth included);
                     default ${DEFAULT_PILOT_BUDGET}
  --min-expected-products N
                     fail the run as unhealthy when a store collects
                     fewer unique products (default:
                     ${DEFAULT_MIN_EXPECTED_PRODUCTS})
  --force-live       DANGEROUS: allow --file to point at the live archive

Resume: continuation pages are checkpointed in <file>.breadth-manifest.json
after their records are appended; re-running skips recorded pages. Discovery
requests rerun each time to keep the facet plan fresh. Bootstrap fetches
(store list, category tree) retry across ${DEFAULT_BOOTSTRAP_ROUNDS} rounds
${DEFAULT_BOOTSTRAP_GAP_MS / 1000}s apart before a store crawl aborts.`);
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