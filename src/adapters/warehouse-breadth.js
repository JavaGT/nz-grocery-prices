/**
 * BREADTH-3 — The Warehouse grid category walker.
 *
 * Transport-agnostic core: walks one `cgid` via offset stepping (32-tile
 * server cap), deduping product IDs across windows and terminating on a
 * 0-tile page. Pacing, budget, and breaker logic are caller-managed.
 *
 * The factory `createCurlTransport` produces a curl/execFile-backed fetch
 * that returns `{ status, body }` — designed for injection in tests.
 *
 * Reuses `parseWarehouseProducts` and `toWarehouseObservation` from
 * the existing adapter.
 */

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseWarehouseProducts, toWarehouseObservation } from "./warehouse.js";

const execFileAsync = promisify(execFile);

const DEFAULT_ORIGIN = "https://www.thewarehouse.co.nz";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36";

const CURL_DEFAULT_HEADERS = {
  accept: "text/html,application/xhtml+xml",
  referer: `${DEFAULT_ORIGIN}/c/food-pets-household/food-drink`,
};

/** Minimum pacing floor in ms enforced unless unsafeFastPacing is true. */
const MIN_DELAY_MS = 3000;

/** Hard max windows to catch offset drift (200 × 32 = 6400 tiles max). */
const DEFAULT_MAX_WINDOWS = 200;

/**
 * Challenge/error-page patterns that indicate the response body is NOT
 * a genuine Warehouse grid page.
 */
const NON_GRID_PATTERNS = [
  "Attention Required",
  "cf-browser-verification",
  "challenge-platform",
  "Just a moment",
];

/**
 * Create a transport async function backed by `execFile` + `curl`.
 *
 * The returned transport takes a URL string and returns
 * `{ status: number, body: string }`.
 *
 * In production, `execFile` is the real promisified version from
 * `node:child_process`.  Tests inject a fake to return fixture HTML.
 *
 * Status is extracted from curl's `--write-out '%{http_code}'` output,
 * appended as the final line of stdout. The body is everything before
 * that line.
 */
export function createCurlTransport(options = {}) {
  const {
    execFile: execFileFn = execFileAsync,
    curlPath = "curl",
    userAgent = DEFAULT_USER_AGENT,
    headers = {},
  } = options;

  return async function curlFetch(url) {
    const mergedHeaders = { ...CURL_DEFAULT_HEADERS, ...headers };
    const headerArgs = Object.entries(mergedHeaders)
      .filter(([name]) => name.toLocaleLowerCase("en-NZ") !== "user-agent")
      .flatMap(([name, value]) => ["--header", `${name}: ${value}`]);

    const { stdout } = await execFileFn(curlPath,
      [
        "--silent",
        "--show-error",
        "--location",
        "--compressed",
        "--max-time",
        "30",
        "--user-agent",
        userAgent,
        ...headerArgs,
        "--write-out",
        "\n%{http_code}",
        url,
      ],
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
    );

    const lastNewline = stdout.lastIndexOf("\n");
    const body = lastNewline >= 0 ? stdout.slice(0, lastNewline) : "";
    const statusLine = lastNewline >= 0 ? stdout.slice(lastNewline + 1).trim() : stdout.trim();
    const status = Number.parseInt(statusLine, 10);

    return {
      status: Number.isFinite(status) ? status : 0,
      body,
    };
  };
}

/**
 * Check whether a response body looks like a genuine Warehouse grid page
 * (as opposed to a Cloudflare challenge, error page, or malformed body).
 * Returns true when the body is plausible HTML grid content.
 */
function looksLikeGridBody(body) {
  if (!body || typeof body !== "string") return false;
  for (const pattern of NON_GRID_PATTERNS) {
    if (body.includes(pattern)) return false;
  }
  // Must contain HTML structure — a real grid response has content.
  return body.includes("<") && body.includes(">");
}

/**
 * Fingerprint a set of product IDs for drift detection.
 * Uses a sorted join so identical product sets produce identical hashes.
 */
function fingerprintProductIds(products) {
  const ids = products.map((p) => p.id).filter(Boolean).sort().join(",");
  return createHash("sha256").update(ids).digest("hex");
}

/**
 * Walk one `cgid` by stepping `start` in increments of 32 until a page
 * returns zero product tiles or the budget/breaker terminates the walk.
 *
 * @param {object} options
 * @param {(url: string) => Promise<{status: number, body: string}>} options.transport
 * @param {string} options.cgid
 * @param {string} [options.origin=DEFAULT_ORIGIN]
 * @param {object} options.store  — store object passed to toWarehouseObservation
 * @param {string} options.observedAt
 * @param {number} [options.delayMs=3000]  — clamped to 3000 minimum unless unsafeFastPacing
 * @param {number} [options.budget=Infinity]
 * @param {Map<string, string>} [options.completed]  — manifest-checkpointed task IDs
 * @param {(msg: string) => void} [options.log]
 * @param {(msg: string) => void} [options.collectWarning]
 * @param {() => number} [options.clock]  — returns ms timestamp
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {(taskId: string) => void} [options.checkpoint]  — called after each
 *   successfully processed offset (the callee persists the manifest)
 * @param {boolean} [options.includeMarketplace=false]  — when true, marketplace
 *   products are NOT excluded
 * @param {boolean} [options.unsafeFastPacing=false]  — bypass the 3s pacing floor
 * @param {number} [options.maxWindows=200]  — hard ceiling on windows before
 *   stopping the walk as unhealthy-complete
 */
export async function crawlCgid({
  transport,
  cgid,
  origin = DEFAULT_ORIGIN,
  store,
  observedAt,
  delayMs = MIN_DELAY_MS,
  budget = Number.POSITIVE_INFINITY,
  completed = new Map(),
  log = () => {},
  collectWarning = () => {},
  clock = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  checkpoint,
  includeMarketplace = false,
  unsafeFastPacing = false,
  maxWindows = DEFAULT_MAX_WINDOWS,
} = {}) {
  if (typeof transport !== "function") {
    throw new TypeError("crawlCgid requires an injectable transport function");
  }
  if (!cgid || typeof cgid !== "string") {
    throw new TypeError("crawlCgid requires a cgid string");
  }
  if (!store || !store.id) {
    throw new TypeError("crawlCgid requires a store object with .id");
  }
  if (!observedAt || typeof observedAt !== "string") {
    throw new TypeError("crawlCgid requires an observedAt ISO string");
  }

  // CONCERN 5 — Enforce pacing floor unless explicitly bypassed.
  if (!unsafeFastPacing && delayMs < MIN_DELAY_MS) {
    throw new TypeError(
      `delayMs (${delayMs}) is below the ${MIN_DELAY_MS}ms pacing floor. ` +
        "The Warehouse aggressively rate-limits; values below 3000ms risk " +
        "immediate 403 blocks. Set unsafeFastPacing=true to bypass this guard.",
    );
  }

  const TILE_STEP = 32;
  const BREAKER_THRESHOLD = 5;

  /** Build the grid URL for a given offset. */
  function gridUrl(start) {
    const url = new URL("/search/updategrid", origin);
    url.searchParams.set("cgid", cgid);
    url.searchParams.set("start", String(start));
    url.searchParams.set("sz", String(TILE_STEP));
    return url.toString();
  }

  /** Stable task id for one offset window. */
  function taskId(start) {
    return `${cgid}:off${start}`;
  }

  const seen = new Map();         // product.id → product (keep-first)
  const observations = [];
  const warnings = [];
  const warn = (message) => {
    warnings.push(message);
    collectWarning(message);
  };

  let start = 0;
  let pagesFetched = 0;
  let pagesWith0Tiles = 0;
  let consecutiveFailures = 0;
  let requestsMade = 0;
  let circuitOpen = false;
  let circuitReason = "";
  let budgetExhausted = false;
  let driftDetected = false;
  let maxWindowsReached = false;

  // BLOCKER 2 — budget is a remaining counter decremented BEFORE every
  // transport invocation (including failed/retried calls).
  let remainingBudget = budget;

  // BLOCKER 3 — fingerprint set for drift detection (hash of sorted product IDs).
  const fingerprints = new Set();

  for (;;) {
    // BLOCKER 2 — budget check: stop if budget exhausted.
    if (remainingBudget <= 0) {
      budgetExhausted = true;
      warn(
        `request budget exhausted (limit ${budget}) after ${pagesFetched} ` +
          `pages; ${seen.size} unique products collected`,
      );
      break;
    }

    // BLOCKER 3 — hard ceiling on number of windows.
    if (pagesFetched >= maxWindows) {
      maxWindowsReached = true;
      warn(
        `max windows (${maxWindows}) reached at offset ${start}; ` +
          `stopping walk as unhealthy-complete. ${seen.size} unique products collected`,
      );
      break;
    }

    const id = taskId(start);

    // BLOCKER 1 — Skip already-checkpointed offsets (manifest resume).
    if (completed.has(id)) {
      start += TILE_STEP;
      continue;
    }

    const url = gridUrl(start);

    // BLOCKER 2 — decrement budget BEFORE transport call (every attempt counts).
    remainingBudget -= 1;
    requestsMade += 1;

    // --- fetch ---
    let response;
    try {
      response = await transport(url);
    } catch (error) {
      // Network/transport error (curl not found, DNS failure, execFile reject).
      consecutiveFailures += 1;
      warn(`${id}: transport error — ${error.message}`);
      if (consecutiveFailures >= BREAKER_THRESHOLD) {
        circuitOpen = true;
        circuitReason =
          `circuit opened after ${BREAKER_THRESHOLD} consecutive transport ` +
          `failures (first in chain: ${id}); aborting the cgid walk`;
        warn(circuitReason);
      } else {
        // Wait and retry this offset on the next iteration.
        log(`${id}: ${consecutiveFailures}/${BREAKER_THRESHOLD} failures, will retry`);
        await sleep(delayMs);
      }
      if (circuitOpen) break;
      continue; // re-try same offset
    }

    // --- classify response ---
    if (response.status === 403) {
      circuitOpen = true;
      circuitReason =
        `Cloudflare 403 on ${id} (${url}) — treating as fatal; ` +
        `the Warehouse is blocking this client. Aborting the cgid walk.`;
      warn(circuitReason);
      break;
    }

    if (response.status >= 400) {
      // Non-403 HTTP error.
      consecutiveFailures += 1;
      warn(`${id}: HTTP ${response.status} — ${response.body?.slice(0, 200)}`);
      if (consecutiveFailures >= BREAKER_THRESHOLD) {
        circuitOpen = true;
        circuitReason =
          `circuit opened after ${BREAKER_THRESHOLD} consecutive HTTP errors ` +
          `(last: ${id} HTTP ${response.status}); aborting the cgid walk`;
        warn(circuitReason);
      } else {
        log(`${id}: ${consecutiveFailures}/${BREAKER_THRESHOLD} HTTP errors, will retry`);
        await sleep(delayMs);
      }
      if (circuitOpen) break;
      continue; // re-try same offset
    }

    // --- success: parse tiles ---
    consecutiveFailures = 0;
    const products = parseWarehouseProducts(response.body);
    pagesFetched += 1;

    if (products.length === 0) {
      // CONCERN 6 — Distinguish genuine empty grid from challenge/error/malformed body.
      if (!looksLikeGridBody(response.body)) {
        consecutiveFailures += 1;
        warn(
          `${id}: body does not look like a grid response (products=0, ` +
            `non-grid patterns detected or non-HTML) — treating as failure`,
        );
        if (consecutiveFailures >= BREAKER_THRESHOLD) {
          circuitOpen = true;
          circuitReason =
            `circuit opened after ${BREAKER_THRESHOLD} consecutive non-grid ` +
            `responses (last: ${id}); aborting the cgid walk`;
          warn(circuitReason);
        } else {
          log(`${id}: ${consecutiveFailures}/${BREAKER_THRESHOLD} non-grid responses, will retry`);
          await sleep(delayMs);
        }
        if (circuitOpen) break;
        continue; // re-try same offset
      }

      // 0-tile page with recognisable grid HTML → catalogue end.
      pagesWith0Tiles += 1;
      log(`${id}: 0 tiles — terminating cgid walk (end of catalogue)`);
      break;
    }

    // CONCERN 4 — exclude marketplace products unless opted in.
    const filteredProducts = includeMarketplace
      ? products
      : products.filter((p) => !p.marketplaceProduct);

    if (filteredProducts.length === 0 && products.length > 0) {
      // All products were marketplace-excluded; still treat the page as
      // processed so we don't loop, but log the skip.
      log(`${id}: all ${products.length} products were marketplace — skipping window`);
      // Mark as completed anyway to avoid re-fetching this offset.
      completed.set(id, new Date().toISOString());
      if (checkpoint) checkpoint(id);
      start += TILE_STEP;
      await sleep(delayMs);
      continue;
    }

    // BLOCKER 3 — fingerprint drift detection.
    const fp = fingerprintProductIds(filteredProducts);
    if (fingerprints.has(fp)) {
      driftDetected = true;
      warn(
        `${id}: repeated product fingerprint detected — the catalogue may ` +
          `have wrapped or the offset is drifting. Treating walk as ` +
          `unhealthy-complete. cgid=${cgid}, offset=${start}`,
      );
      break;
    }
    fingerprints.add(fp);

    // Dedupe by product.id; map fresh ones to observations.
    let freshCount = 0;
    for (const product of filteredProducts) {
      if (!product.id || seen.has(product.id)) continue;
      seen.set(product.id, product);
      freshCount += 1;
      const observation = toWarehouseObservation(product, store, {
        observedAt,
        origin,
      });
      if (observation) observations.push(observation);
    }

    log(
      `${id}: +${freshCount} new (${seen.size} unique, ` +
        `${observations.length} observations)`,
    );

    // BLOCKER 1 — checkpoint this offset as completed.
    completed.set(id, new Date().toISOString());
    if (checkpoint) checkpoint(id);

    // Advance offset for next page.
    start += TILE_STEP;

    // Pacing between requests (the 3s floor).
    await sleep(delayMs);
  }

  const unhealthyTermination = budgetExhausted || circuitOpen || driftDetected || maxWindowsReached;

  return {
    cgid,
    observations,
    uniqueCount: seen.size,
    pagesFetched,
    pagesWith0Tiles,
    warnings,
    requestsMade,
    budgetExhausted,
    circuitOpen,
    circuitReason,
    consecutiveFailures: circuitOpen ? consecutiveFailures : 0,
    // BLOCKER 3 additions
    driftDetected,
    maxWindowsReached,
    unhealthyTermination,
  };
}