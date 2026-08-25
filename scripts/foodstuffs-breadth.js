#!/usr/bin/env node
/**
 * BREADTH-1 — Foodstuffs full-catalogue breadth collector.
 *
 * Facet-driven per-store crawl (see docs/research/foodstuffs-full-catalogue.md):
 *
 *   1. One unfiltered page-0 search (hitsPerPage 50) captures the store's
 *      category0NI facet counts and `facets.tobacco.false` — the uncapped
 *      catalogue size used for reconciliation.
 *   2. Every category0NI value gets its own scoped page-0 (extraFilters
 *      `category0NI:"X"`). Categories with count > 900 exceed Algolia's
 *      1,000-hit pagination clamp, so their scoped category1NI children
 *      become the leaves instead (observed children sit far below 1,000).
 *   3. Every leaf is paginated fully at 50 hits/page.
 *   4. Products are deduped by productId across overlapping pseudo-categories
 *      ("Featured" etc.), and the unique count is reconciled against the
 *      tobacco:false target (warn when |delta| > 0.5%).
 *
 * Records are appended through PriceArchive.record as OFFER REVISIONS ONLY —
 * no snapshotScope (snapshot scope stays "specials").
 *
 * Resume: the manifest (<file>.breadth-manifest.json) checkpoints
 * continuation pages only, keyed by stable task ids
 * `${storeId}:${categoryKey}:page${n}`. An id is recorded AFTER its wave's
 * observations are durably appended (mark-after-record), so a crashed run
 * can never skip unrecorded work. Discovery requests (every page 0) rerun
 * each run — they are cheap (~40/store), keep the facet plan fresh, and
 * their hits dedupe against already-archived products. Delete the manifest
 * to force a full re-crawl; duplicate offer revisions are content-hash
 * deduped by the archive, so re-crawling is always safe.
 *
 * Requests flow through scripts/lib/crawler.js via a bridge: the Foodstuffs
 * clients are constructed with the bridge as their injected `fetch`, so
 * every client HTTP call (anonymous auth included) becomes a crawler task
 * sharing one per-host pacing slot per run. The crawler owns pacing, retry,
 * and budget; the adapter keeps owning auth, request bodies, and observation
 * mapping.
 */

import { PriceArchive } from "../src/archive.js";
import {
  NewWorldClient,
  PaknsaveClient,
  toPriceObservation,
} from "../src/adapters/foodstuffs.js";
import { JsonlObservationRepository } from "../src/repository.js";
import {
  OUTCOME_CATEGORIES,
  createCrawler,
  loadManifest,
  saveManifest,
} from "./lib/crawler.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const { BUDGET_SKIPPED } = OUTCOME_CATEGORIES;

export const DEFAULT_FILE = "data/breadth-pilot.jsonl";
/**
 * Finite default request cap for pilot runs. Explicit --budget overrides.
 * A planner regression must surface as budget-skipped outcomes, never as
 * an unbounded crawl against the retailer API.
 */
export const DEFAULT_PILOT_BUDGET = 2000;
const LIVE_ARCHIVE_FALLBACK = "data/prices.jsonl";

/** The breadth path may never write the authoritative archive by accident. */
export function assertNotLiveArchive(file, { forceLive = false } = {}) {
  const candidate = resolve(file);
  const live = resolve(process.env.ARCHIVE_FILE ?? LIVE_ARCHIVE_FALLBACK);
  if (candidate === live && !forceLive) {
    throw new Error(
      `Refusing to breadth-collect into ${file}: that resolves to the live ` +
        `archive. Breadth pilots write data/breadth-pilot.jsonl; pass ` +
        `--force-live only with an explicit owner decision.`,
    );
  }
}
const MANIFEST_SUFFIX = ".breadth-manifest.json";
const MANIFEST_VERSION = 1;
const PAGE_SIZE = 50;
/** Facet counts above this exceed the 1,000-hit pagination clamp → split. */
const SPLIT_THRESHOLD = 900;
/** Consecutive failed requests before the circuit opens (see crawlStore). */
export const BREAKER_THRESHOLD = 5;
/** Reconciliation tolerance: warn when |delta| > 0.5% of the target. */
const RECONCILE_TOLERANCE = 0.005;
/** Algolia index caps: totalHits clamps at 1,000 across 20 pages. */
const HIT_CLAMP = 1000;
const PAGE_CLAMP = 20;

const BANNER_CLIENTS = {
  paknsave: PaknsaveClient,
  newworld: NewWorldClient,
};

// ---- pure planning helpers (unit-tested) ---------------------------------

/**
 * Stable category key embedded in task ids: "all" for the unfiltered
 * catalogue scan, else `cat0=<name>` / `cat0=<name>|cat1=<child>`.
 */
export function categoryKey(categoryPath) {
  if (categoryPath.length === 0) return "all";
  if (categoryPath.length === 1) return `cat0=${categoryPath[0]}`;
  return `cat0=${categoryPath[0]}|cat1=${categoryPath[1]}`;
}

/** Stable crawler/manifest task id for one search page. */
export function taskId(storeId, categoryPath, page) {
  return `${storeId}:${categoryKey(categoryPath)}:page${page}`;
}

/**
 * Derive { storeId, categoryPath, page } from a client request init's JSON
 * body, or null for non-search calls (anonymous auth, other endpoints). The
 * bridge uses this for task ids; a unit test pins it to the ids the
 * collector computes, so manifest keys stay stable across both paths.
 */
export function parseSearchRequest(init) {
  let body;
  try {
    body = JSON.parse(init?.body ?? "null");
  } catch {
    return null;
  }
  const filters = body?.algoliaQuery?.filters;
  if (typeof filters !== "string") return null;
  const storeMatch = filters.match(/(?:^| AND )stores:([^\s]+)/);
  if (!storeMatch) return null;
  const categoryPath = [];
  for (const level of ["category0NI", "category1NI"]) {
    const match = filters.match(new RegExp(`(?:^| AND )${level}:"([^"]+)"`));
    if (!match) break;
    categoryPath.push(match[1]);
  }
  const page = body.page;
  return {
    storeId: storeMatch[1],
    categoryPath,
    page: Number.isInteger(page) ? page : 0,
  };
}

/** Raw Algolia filter strings for a category path (adapter joins with AND). */
export function categoryFilters(categoryPath) {
  const levels = ["category0NI", "category1NI"];
  return categoryPath.map((value, index) => {
    if (value.includes('"')) {
      throw new Error(`category name contains a quote character: ${value}`);
    }
    return `${levels[index]}:"${value}"`;
  });
}

/** Uncapped catalogue size from the page-0 facets, when reported. */
export function tobaccoTarget(envelope) {
  const raw = envelope?.algoliaSearchResult?.facets?.tobacco?.false;
  const count = Number(raw);
  return Number.isFinite(count) ? count : undefined;
}

/** Sorted [{ name, count }] entries of one facet from an envelope. */
export function facetEntries(envelope, facetName) {
  const counts = envelope?.algoliaSearchResult?.facets?.[facetName] ?? {};
  return Object.entries(counts)
    .map(([name, count]) => ({ name, count: Number(count) }))
    .sort((a, b) => a.name.localeCompare(b.name, "en-NZ"));
}

/** Split decision: counts strictly above SPLIT_THRESHOLD need drill-down. */
export function needsSplit(entry) {
  return entry.count > SPLIT_THRESHOLD;
}

/**
 * Continuation pages (1..totalPages-1) implied by a leaf's page-0 envelope.
 * `truncated` flags a leaf saturating the index clamp — its tail may be
 * unreachable and reconciliation is expected to flag the shortfall.
 */
export function continuationPages(envelope) {
  const totalPages = envelope?.totalPages ?? 1;
  const pages = [];
  for (let page = 1; page < totalPages; page += 1) pages.push(page);
  const truncated =
    (envelope?.totalHits ?? 0) >= HIT_CLAMP && totalPages >= PAGE_CLAMP;
  return { pages, truncated };
}

/**
 * Absorb hits into the per-store dedup map (productId → hit, keep-first —
 * popularity order is stable, so the first sight is the canonical one).
 * Returns only first-seen hits so callers map observations incrementally.
 */
export function absorbHits(seen, hits) {
  const fresh = [];
  for (const product of hits ?? []) {
    const id = product?.productId;
    if (id == null || seen.has(id)) continue;
    seen.set(id, product);
    fresh.push(product);
  }
  return fresh;
}

/**
 * Coverage reconciliation against the tobacco:false target. `withinTolerance`
 * is false only when a target exists and |delta| exceeds 0.5% of it.
 */
export function reconcile(uniqueCount, target) {
  if (target === undefined) {
    return { target, delta: undefined, deltaRatio: undefined, withinTolerance: true };
  }
  const delta = uniqueCount - target;
  const deltaRatio = target === 0 ? 0 : Math.abs(delta) / target;
  return {
    target,
    delta,
    deltaRatio,
    withinTolerance: deltaRatio <= RECONCILE_TOLERANCE,
  };
}

// ---- crawler bridge ------------------------------------------------------

function budgetError(limit) {
  const error = new Error(
    `breadth request budget exhausted (limit ${limit}); ` +
      "remaining work was left un-done for the next run",
  );
  error.code = "EBREADTHBUDGET";
  return error;
}

/**
 * Route Foodstuffs client HTTP calls through a crawler as individual tasks.
 *
 * Clients call `fetch(url, init)`; entries queue and drain through
 * `crawler.run()` in batches (one task per HTTP call, input order
 * preserved), so per-host pacing, retries, and observability all come from
 * the shared crawl core. Successful outcomes resolve with the transport
 * response (clients parse JSON as usual); failures and budget-exhausted
 * admissions reject (the latter with an EBREADTHBUDGET-coded error).
 *
 * `budget` caps admitted tasks across the WHOLE collect — auth calls
 * included, crawler-level retries excluded (a retried task re-attempts
 * inside one admission).
 */
export function createCrawlerBridge({ crawler, budget = Number.POSITIVE_INFINITY } = {}) {
  if (!crawler || typeof crawler.run !== "function") {
    throw new TypeError("createCrawlerBridge requires a crawler from createCrawler()");
  }
  const queue = [];
  let admitted = 0;
  let anonCounter = 0;
  // Non-null while a drain loop is live; fetch() callers must not start a
  // second one. The loop re-checks the queue after exiting (see pump).
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
      const tasks = batch.map((entry) => {
        const parsed = parseSearchRequest(entry.init);
        return {
          id: parsed
            ? taskId(parsed.storeId, parsed.categoryPath, parsed.page)
            : `anon-${(anonCounter += 1)}`,
          url: entry.url,
          init: entry.init,
        };
      });
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
      // A fetch() that queued during the final awaited batch saw a live
      // drain and skipped pumping; pick up anything left behind.
      if (queue.length > 0) pump();
    });
  }

  /** Drop-in fetch for Foodstuffs clients (adapter's injectable seam). */
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
 * Crawl one store's full catalogue. Waves of planned search requests run
 * through bridge-backed clients; after each wave the freshly mapped
 * observations are appended via `commitWave(observations, continuationIds)`
 * BEFORE their page ids enter the manifest (mark-after-record).
 *
 * `claimBudget(want)` meters admitted SEARCH requests ahead of the bridge's
 * hard cap (auth included there); returning 0 stops the store cleanly.
 * `completed` (Map of manifest ids) suppresses re-spawning recorded pages.
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
  // Continuation pages already spawned anywhere in this crawl — leaf page-k
  // envelopes re-derive their sibling pages, so this guard (with the
  // manifest's `completed`) keeps each page a single request per run.
  const planned = new Set();
  const warnings = [];
  const warn = (message) => {
    warnings.push(message);
    collectWarning(`${store.name}: ${message}`);
  };
  let rootTarget;
  let pagesFetched = 0;
  const emptyPages = [];

  // Circuit breaker: the Foodstuffs API answers rate abuse by hanging
  // (15s+ tarpits), and hammering through it deepens the block. After
  // BREAKER_THRESHOLD consecutive failed requests, abort the store run —
  // resume continues from the manifest on a later, cooler attempt.
  let consecutiveFailures = 0;
  let circuitOpenedAt = null;

  // Region is a sort-order prefix ("NI"/"SI"); anything else falls back to
  // the adapter default rather than producing an invalid sortOrder (400).
  const region = ["NI", "SI"].includes(store.region) ? store.region : undefined;

  const search = (categoryPath, page) =>
    client.searchProducts({
      storeId: store.id,
      region,
      page,
      hitsPerPage: PAGE_SIZE,
      ...(categoryPath.length ? { extraFilters: categoryFilters(categoryPath) } : {}),
    });

  /**
   * Run one wave of planned requests. Thunk kinds: "root" (unfiltered
   * page-0, seeds the plan), "cat0" (top-level page-0; splits or paginates),
   * "leaf" (child page-0 or any continuation page). Returns thunks for the
   * next wave plus any carried over by a partial budget grant.
   */
  async function runWave(thunks) {
    const granted = claimBudget(thunks.length);
    if (granted <= 0) return { spawned: [], carried: thunks, budgetStop: true };
    const batch = thunks.slice(0, granted);
    const carried = thunks.slice(granted);

    const settled = await Promise.allSettled(
      batch.map((thunk) =>
        search(thunk.categoryPath, thunk.page).then((envelope) => ({
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
      // An empty continuation page means the API over-reported totalPages;
      // stop trusting further planning from this signal (reconciliation
      // remains the completeness guard for under-reporting).
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

      if (thunk.kind === "root") {
        rootTarget = tobaccoTarget(envelope);
        if (rootTarget === undefined) {
          warn("tobacco:false facet missing — coverage cannot be reconciled");
        }
        for (const entry of facetEntries(envelope, "category0NI")) {
          spawned.push({
            kind: "cat0",
            id: taskId(store.id, [entry.name], 0),
            categoryPath: [entry.name],
            page: 0,
            count: entry.count,
          });
        }
        continue;
      }

      if (thunk.kind === "cat0" && needsSplit(thunk)) {
        // Above the clamp: scoped category1NI children become the leaves.
        for (const child of facetEntries(envelope, "category1NI")) {
          if (needsSplit(child)) {
            warn(
              `child "${child.name}" of "${thunk.categoryPath[0]}" has ` +
                `${child.count} products (> ${SPLIT_THRESHOLD}); only the ` +
                "first 1,000 will be crawled",
            );
          }
          spawned.push({
            kind: "leaf",
            id: taskId(store.id, [...thunk.categoryPath, child.name], 0),
            categoryPath: [...thunk.categoryPath, child.name],
            page: 0,
          });
        }
        continue;
      }

      // Leaf (or small-enough top-level category): paginate fully.
      const { pages, truncated } = continuationPages(envelope);
      if (truncated) {
        warn(
          `${thunk.id} saturates the pagination clamp (${envelope.totalHits} ` +
            `hits / ${envelope.totalPages} pages); tail may be unreached`,
        );
      }
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
      // Only continuation pages checkpoint; discovery page-0s rerun freely.
      if (thunk.page >= 1) continuationIds.push(thunk.id);
    }

    await commitWave(observations, continuationIds);
    return { spawned, carried, budgetStop, circuitOpen: circuitOpenedAt !== null };
  }

  let pending = [{ kind: "root", id: taskId(store.id, [], 0), categoryPath: [], page: 0 }];
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
        `circuit opened after ${consecutiveFailures} consecutive failed ` +
        `requests (first: ${circuitOpenedAt}) — the API is blocking this ` +
        `client; aborting the run. Resume from the manifest after a ` +
        `cooldown (suggest ≥30 min), then re-run with wider --delay-ms.`;
      warn(circuitError);
      break;
    }
    pending = wave.spawned.concat(wave.carried);
  }

  // Coverage gate (research step 3): deduped unique count vs the uncapped
  // tobacco:false total. Outside 0.5% usually means pseudo-category overlap
  // drift, mid-crawl promo changes, or unattributed products.
  const reconciliation = reconcile(seen.size, rootTarget);
  if (rootTarget !== undefined && !reconciliation.withinTolerance) {
    warn(
      `coverage ${seen.size} unique vs ${rootTarget} catalogue products ` +
        `(delta ${reconciliation.delta}, ` +
        `${(reconciliation.deltaRatio * 100).toFixed(2)}%; tolerance ` +
        `${(RECONCILE_TOLERANCE * 100).toFixed(1)}%)`,
    );
  }

  return {
    store,
    retailer: client.retailer,
    uniqueCount: seen.size,
    pagesFetched,
    emptyPages,
    rootFound: rootTarget !== undefined,
    warnings,
    budgetExhausted,
    ...(circuitError ? { error: circuitError } : {}),
    reconciliation,
  };
}

// ---- orchestration -------------------------------------------------------

/**
 * Resolve `queries` (store ids or name fragments) against a store list.
 * Exact id or case-insensitive full-name match wins; otherwise the query is
 * treated as a name/address fragment and must match exactly one store.
 */
export function resolveStores(queries, allStores) {
  return queries.map((query) => {
    const lowered = query.toLowerCase();
    const exact = allStores.find(
      (store) =>
        store.id === query ||
        (store.name ?? "").toLowerCase() === lowered,
    );
    if (exact) return exact;
    const matches = allStores.filter(
      (store) =>
        (store.name ?? "").toLowerCase().includes(lowered) ||
        (store.address ?? "").toLowerCase().includes(lowered),
    );
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      throw new Error(`No store matches "${query}"`);
    }
    throw new Error(
      `Store "${query}" is ambiguous: ${matches.map((store) => store.name).join(", ")}`,
    );
  });
}

/** Parse CLI argv into options; throws TypeError on bad values. */
export function parseArgs(argv) {
  const options = {
    retailer: "both",
    storeQueries: [],
    file: DEFAULT_FILE,
    delayMs: 1000,
    budget: Number.POSITIVE_INFINITY,
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
  if (!["paknsave", "newworld", "both"].includes(options.retailer)) {
    throw new TypeError("--retailer must be paknsave, newworld, or both");
  }
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    throw new TypeError("--delay-ms must be a non-negative number");
  }
  if (!Number.isInteger(options.budget) || options.budget < 1) {
    if (options.budget !== Number.POSITIVE_INFINITY) {
      throw new TypeError("--budget must be a positive integer");
    }
  }
  return options;
}

/**
 * Run a breadth collection. Options:
 * - retailer: "paknsave" | "newworld" | "both" (default both — the pilot
 *   gate needs one store of each banner).
 * - storeQueries: optional store ids/name fragments; without them the pilot
 *   default applies (first store alphabetically per selected banner).
 * - file: archive path (DEFAULT data/breadth-pilot.jsonl — never the live
 *   prices.jsonl; the caller must opt into that explicitly).
 * - delayMs / budget: pacing floor and hard HTTP-call cap for the crawler.
 * - transport: injected fetch behind the crawler (tests use fakes).
 * - storesByRetailer: pre-resolved { [retailer]: store[] } bypassing store
 *   resolution (tests); CLI resolution goes through listStores instead.
 * - observedAt / clock: timestamp + archive clock injectables.
 */
export async function runCollection(options = {}) {
  const {
    retailer = "both",
    storeQueries = [],
    file = DEFAULT_FILE,
    delayMs = 1000,
    // Finite pilot cap (2 stores × ~275 requests ≈ 550; 2000 leaves ~3×
    // headroom while bounding a planner regression). Override with --budget.
    budget = DEFAULT_PILOT_BUDGET,
    forceLive = false,
    transport = globalThis.fetch,
    storesByRetailer = null,
    observedAt = new Date().toISOString(),
    clock = () => new Date(),
    log = () => {},
    collectWarning = (message) => console.error(`warn: ${message}`),
  } = options;

  const retailers = retailer === "both"
    ? ["paknsave", "newworld"]
    : [retailer];
  assertNotLiveArchive(file, { forceLive });
  const manifestPath = `${resolve(file)}${MANIFEST_SUFFIX}`;

  const crawler = createCrawler({
    fetch: transport,
    minHostDelayMs: delayMs,
    budget,
  });
  const bridge = createCrawlerBridge({ crawler, budget });
  // retry:false — the CRAWLER owns retry policy for breadth (single retry
  // owner). The adapter's internal fetchWithRetry retries would stack on
  // top and hammer a tarpitting server with multiplied attempts.
  const clients = Object.fromEntries(
    retailers.map((name) => [
      name,
      new BANNER_CLIENTS[name]({ fetch: bridge.fetch, retry: false }),
    ]),
  );

  // Resolve stores: explicit objects > queries > pilot default.
  const plans = [];
  for (const name of retailers) {
    let stores;
    if (storesByRetailer && storesByRetailer[name]) {
      stores = storesByRetailer[name];
    } else {
      const all = await clients[name].listStores();
      if (all.length === 0) throw new Error(`No ${name} stores returned by the store list API`);
      const queries = storeQueries.filter((query) => {
        // Queries apply to every selected banner; unmatched banners fall
        // back to the pilot default so `--retailer both --store X` still
        // crawls one store per banner.
        try {
          resolveStores([query], all);
          return true;
        } catch {
          collectWarning(`no ${name} store matches "${query}"; using pilot default`);
          return false;
        }
      });
      stores = queries.length > 0
        ? resolveStores(queries, all)
        : [[...all].sort((a, b) => a.name.localeCompare(b.name, "en-NZ"))[0]];
    }
    for (const store of stores) {
      plans.push({ retailer: name, store });
    }
  }

  // Resume state: continuation-page ids recorded by previous runs.
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
    // Mark-after-record: ids land in the manifest only once the wave's
    // observations are durably appended. A failed persist is SAFE (manifest
    // lags archive → next run re-crawls and content-hash-dedupes) but must
    // be visible: it is counted and flips summary.healthy.
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

  // Search-request metering ahead of the bridge's hard cap (which also
  // covers anonymous-auth calls).
  const claimBudget = (want) =>
    Math.max(0, Math.min(want, budget - bridge.admittedCount()));

  log(
    `foodstuffs-breadth: ${plans.map((plan) => plan.store.name).join(", ")}` +
      ` → ${file}`,
  );

  const storeResults = [];
  for (const { retailer: name, store } of plans) {
    try {
      const result = await crawlStore({
        client: clients[name],
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
        retailer: name,
        uniqueCount: 0,
        pagesFetched: 0,
        rootFound: false,
        warnings: [`crawl aborted: ${error.message}`],
        budgetExhausted: false,
        reconciliation: reconcile(0, undefined),
        error: error.message,
      });
    }
  }

  const unhealthy =
    storeResults.some(
      (result) =>
        !result.rootFound ||
        result.budgetExhausted ||
        !result.reconciliation.withinTolerance ||
        result.error,
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
      target: result.reconciliation.target,
      delta: result.reconciliation.delta,
      coverageOk: result.reconciliation.withinTolerance,
      pagesFetched: result.pagesFetched,
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
  node scripts/foodstuffs-breadth.js [--retailer paknsave|newworld|both]
      [--store <id-or-name>]... [--file <jsonl>] [--delay-ms N] [--budget N]

Foodstuffs full-catalogue breadth collector (BREADTH-1). Per store: one
unfiltered page-0 search reads category0NI facet counts and the uncapped
catalogue size (facets.tobacco.false); categories with more than 900
products are drilled down through category1NI children (Algolia clamps
pagination at 1,000 hits; observed children sit far below); every leaf is
paginated fully at 50 hits/page; products are deduped by productId across
overlapping pseudo-categories and reconciled against the catalogue size
(|delta| > 0.5% warns).

Options:
  --retailer <name>  paknsave, newworld, or both (default: both)
  --store <value>    store UUID or name fragment; repeatable. Omit for the
                     pilot pair: the first PAK'nSAVE and first New World
                     store alphabetically (printed before crawling).
  --file <path>      archive to append offer revisions to
                     (default: ${DEFAULT_FILE}; NEVER the live prices.jsonl —
                     breadth writes no snapshotScope, specials snapshots stay
                     with the regular collectors)
  --delay-ms N       minimum gap between requests to the same host
                     (default: 1000)
  --budget N         hard cap on HTTP calls this run (auth included);
                     default 2000 (pilot-sized); unfinished work resumes on
                     the next run
  --force-live       DANGEROUS: allow --file to point at the live archive

Resume: continuation pages are checkpointed in <file>.breadth-manifest.json
after their records are appended; re-running skips recorded pages. Discovery
requests rerun each time to keep the facet plan fresh. Exit code 1 signals
failed reconciliation, a missing tobacco:false facet, or budget exhaustion.`);
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
