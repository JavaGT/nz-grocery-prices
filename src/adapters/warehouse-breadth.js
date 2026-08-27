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
 * Walk one `cgid` by stepping `start` in increments of 32 until a page
 * returns zero product tiles or the budget/breaker terminates the walk.
 *
 * @param {object} options
 * @param {(url: string) => Promise<{status: number, body: string}>} options.transport
 * @param {string} options.cgid
 * @param {string} [options.origin=DEFAULT_ORIGIN]
 * @param {object} options.store  — store object passed to toWarehouseObservation
 * @param {string} options.observedAt
 * @param {number} [options.delayMs=3000]
 * @param {number} [options.budget=Infinity]
 * @param {Map<string, string>} [options.completed]  — manifest-checkpointed task IDs
 * @param {(msg: string) => void} [options.log]
 * @param {(msg: string) => void} [options.collectWarning]
 * @param {() => number} [options.clock]  — returns ms timestamp
 * @param {(ms: number) => Promise<void>} [options.sleep]
 */
export async function crawlCgid({
  transport,
  cgid,
  origin = DEFAULT_ORIGIN,
  store,
  observedAt,
  delayMs = 3000,
  budget = Number.POSITIVE_INFINITY,
  completed = new Map(),
  log = () => {},
  collectWarning = () => {},
  clock = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
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

  for (;;) {
    // Budget check before each request.
    if (requestsMade >= budget) {
      budgetExhausted = true;
      warn(
        `request budget exhausted (limit ${budget}) after ${pagesFetched} ` +
          `pages; ${seen.size} unique products collected`,
      );
      break;
    }

    const id = taskId(start);

    // Skip already-checkpointed offsets (manifest resume).
    if (completed.has(id)) {
      start += TILE_STEP;
      continue;
    }

    const url = gridUrl(start);

    // --- fetch ---
    let response;
    try {
      response = await transport(url);
      requestsMade += 1;
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
      // 0-tile page → catalogue end.
      pagesWith0Tiles += 1;
      log(`${id}: 0 tiles — terminating cgid walk (end of catalogue)`);
      break;
    }

    // Dedupe by product.id; map fresh ones to observations.
    let freshCount = 0;
    for (const product of products) {
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

    // Advance offset for next page.
    start += TILE_STEP;

    // Pacing between requests (the 3s floor).
    await sleep(delayMs);
  }

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
  };
}