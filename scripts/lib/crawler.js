/**
 * Shared polite crawl core for breadth collectors (BREADTH-0).
 *
 * One factory covering the five concerns every breadth collector needs,
 * with no retailer specifics:
 *
 * - Pacing: per-host token bucket. Requests to the same host are strictly
 *   serialized with a minimum gap measured completion → next dispatch
 *   (never two in-flight per host); different hosts never block each other.
 * - Retries: retryable statuses (default 429/500/502/503/504) and retryable
 *   network errors back off exponentially with jitter; a Retry-After header
 *   (delta-seconds or HTTP-date) takes precedence, capped at maxBackoffMs.
 * - Budget: hard cap on fetch invocations per run() (retries included).
 *   Exhaustion halts cleanly: remaining tasks resolve as `budget-skipped`.
 * - Resume: optional JSON manifest (loadManifest/saveManifest) records
 *   completed task ids after each success, atomically, so a crashed run
 *   can resume. ONE crawler instance per manifest file: persistence is
 *   serialized per instance only — two concurrent processes sharing a
 *   manifest would lose updates. (Breadth collectors run one-at-a-time
 *   under the archive lock, which upholds this.)
 * - Observability: structured events on `crawler.events`. Callers decide
 *   what to persist (e.g. data/collection-health.jsonl); this module never
 *   writes health files.
 *
 * Transport-agnostic: every request goes through the injected
 * `fetch(url, init)`. Responses pass through untouched — callers read
 * bodies. The core only relies on `{ status, headers.get(name),
 * body?.cancel() }`, so fake responses work in tests and Warehouse can
 * later inject its execFile-curl transport.
 */

import { EventEmitter } from "node:events";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

/** Terminal classifications for a task. Consumers switch on these. */
export const OUTCOME_CATEGORIES = Object.freeze({
  SUCCESS: "success",
  ALREADY_DONE: "already-done",
  FATAL_HTTP: "fatal-http",
  RETRY_EXHAUSTED: "retry-exhausted",
  NETWORK_FATAL: "network-fatal",
  BUDGET_SKIPPED: "budget-skipped",
  INVALID_TASK: "invalid-task",
});

const {
  SUCCESS,
  ALREADY_DONE,
  FATAL_HTTP,
  RETRY_EXHAUSTED,
  NETWORK_FATAL,
  BUDGET_SKIPPED,
  INVALID_TASK,
} = OUTCOME_CATEGORIES;

const DEFAULT_MIN_HOST_DELAY_MS = 1000;
const DEFAULT_CONCURRENCY = 2;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30000;
const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];
// DNS-level failures are classified network-fatal: a missing host will not
// heal by retrying, and breadth crawls would burn budget re-dialing.
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
]);

const MANIFEST_VERSION = 1;

/**
 * Read a manifest previously written by saveManifest.
 * Returns null when the file does not exist. Corrupt JSON throws with the
 * path named — resume gaps should be loud, not silent fresh starts.
 */
export async function loadManifest(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(`manifest at ${path} is not valid JSON: ${error.message}`);
  }
}

/**
 * Persist manifest data atomically (write sibling tmp file, then rename) so
 * a crash mid-write can never leave a torn checkpoint behind. The tmp name
 * is unique per call: concurrent workers persisting at the same moment must
 * never share a tmp file (pid alone is NOT enough — two overlapping saves
 * from one process would interleave into the same path and corrupt it).
 */
export async function saveManifest(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(data ?? null, null, 2)}\n`);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/**
 * Create a crawler. Options:
 * - fetch (required): `(url, init) => response`. Injected for tests and so
 *   Warehouse can supply its curl-based transport.
 * - minHostDelayMs: pacing floor between same-host requests (default 1000).
 * - hostDelays: `{ [host]: ms }` raises (never lowers) the floor per host.
 * - concurrency: worker count pulling from the task queue (default 2).
 * - budget: max fetch invocations per run(), retries included
 *   (default unlimited).
 * - maxRetries: retries after the initial attempt (default 3).
 * - baseBackoffMs / maxBackoffMs: exponential backoff bounds.
 * - retryStatuses: status codes eligible for retry (default 429/5xx subset).
 * - manifest: optional `{ path, initialCompleted? }` enabling resume.
 * - sleep / clock / random: injectables for deterministic tests.
 *
 * Returns `{ run(tasks), events }`. run() resolves with
 * `{ results, summary }`; results are in input order with one outcome per
 * task — a task failure never rejects the run.
 */
export function createCrawler(options = {}) {
  const {
    fetch,
    minHostDelayMs = DEFAULT_MIN_HOST_DELAY_MS,
    hostDelays = {},
    concurrency = DEFAULT_CONCURRENCY,
    budget = Number.POSITIVE_INFINITY,
    maxRetries = DEFAULT_MAX_RETRIES,
    baseBackoffMs = DEFAULT_BASE_BACKOFF_MS,
    maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
    retryStatuses = RETRYABLE_STATUSES,
    manifest = null,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    clock = Date.now,
    random = Math.random,
  } = options;

  if (typeof fetch !== "function") {
    throw new TypeError(
      "createCrawler requires an injected fetch(url, init) — no implicit network access",
    );
  }
  if (!Number.isFinite(minHostDelayMs) || minHostDelayMs < 0) {
    throw new TypeError("minHostDelayMs must be a non-negative number");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new TypeError("concurrency must be a positive integer");
  }

  const events = new EventEmitter();

  /** @type {Map<string, { readyAt: number, chain: Promise<void> }>} */
  const hostSlots = new Map();
  const manifestConfig = manifest ? { ...manifest } : null;

  // Per-run state (reset by run() so one crawler can serve successive runs).
  let remaining = budget;
  let budgetAnnounced = false;
  let stats = freshStats();
  // Cross-run state: completed task ids for resume.
  let completed = new Map();

  function freshStats() {
    return {
      tasks: 0,
      requestsMade: 0,
      retries: 0,
      succeeded: 0,
      resumed: 0,
      failed: 0,
      skippedBudget: 0,
      manifestErrors: 0,
    };
  }

  function delayForHost(host) {
    return Math.max(minHostDelayMs, hostDelays[host] ?? 0);
  }

  /** Synchronous check-and-decrement: safe under concurrent workers. */
  function takeFromBudget() {
    if (remaining <= 0) return false;
    remaining -= 1;
    stats.requestsMade += 1;
    return true;
  }

  function announceBudgetExhausted() {
    if (budgetAnnounced) return;
    budgetAnnounced = true;
    events.emit("budget", { used: stats.requestsMade, limit: budget });
  }

  function computeBackoff(attempt) {
    const exponential = Math.min(baseBackoffMs * 2 ** attempt, maxBackoffMs);
    const jitter = Math.round(exponential * 0.2 * random());
    return Math.min(exponential + jitter, maxBackoffMs);
  }

  /** Retry-After delta-seconds or HTTP-date, capped at maxBackoffMs. */
  function parseRetryAfter(headers) {
    const raw = headers?.get?.("retry-after");
    if (raw == null) return null;
    const seconds = Number(raw);
    if (Number.isInteger(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, maxBackoffMs);
    }
    const at = Date.parse(raw);
    if (!Number.isNaN(at)) {
      return Math.min(Math.max(0, at - clock()), maxBackoffMs);
    }
    return null;
  }

  function isRetryableStatus(status) {
    return retryStatuses.includes(status);
  }

  function isRetryableNetworkError(error) {
    if (error?.name === "TimeoutError") return true;
    return RETRYABLE_NETWORK_CODES.has(error?.cause?.code);
  }

  /**
   * Run fn() on the host's serialized slot: waits out the pacing gap first,
   * then stamps readyAt = now + delay on the way out so the next same-host
   * request starts no earlier than one full gap after this one finished.
   * Different hosts get independent slots, so they never block each other.
   */
  function withHostSlot(host, fn) {
    let slot = hostSlots.get(host);
    if (!slot) {
      slot = { readyAt: 0, chain: Promise.resolve() };
      hostSlots.set(host, slot);
    }
    const turn = slot.chain.then(async () => {
      const waitMs = Math.max(0, slot.readyAt - clock());
      if (waitMs > 0) {
        events.emit("pace", { host, waitMs });
        await sleep(waitMs);
      }
      try {
        return await fn();
      } finally {
        slot.readyAt = clock() + delayForHost(host);
      }
    });
    // A failed turn must not poison the chain for later requests.
    slot.chain = turn.then(() => {}, () => {});
    return turn;
  }

  async function discardBody(response) {
    // Free the socket of a response we are about to replace with a retry.
    try {
      await response.body?.cancel?.();
    } catch {
      /* draining is best-effort and must never fail the task */
    }
  }

  /**
   * Execute one task through budget → host slot → fetch → classify, retrying
   * retryable failures until maxRetries is spent. Every fetch invocation
   * (initial or retry) consumes budget.
   */
  async function executeTask(task) {
    const startedAt = clock();
    const url = typeof task.url === "string" ? task.url : null;
    let host = null;
    if (url !== null) {
      try {
        const parsed = new URL(url);
        host = parsed.protocol === "http:" || parsed.protocol === "https:"
          ? parsed.host
          : null;
      } catch {
        host = null;
      }
    }
    const ctx = {
      taskId: String(task.id ?? url ?? "unknown"),
      url,
      host,
      init: task.init ?? {},
      startedAt,
    };

    if (!url || !host) {
      return finish(ctx, {
        ok: false,
        category: INVALID_TASK,
        attempts: 0,
        error: new Error("task needs an absolute http(s) url"),
      });
    }

    let retriesUsed = 0;
    for (;;) {
      if (!takeFromBudget()) {
        announceBudgetExhausted();
        return finish(ctx, { ok: false, category: BUDGET_SKIPPED, attempts: retriesUsed });
      }

      events.emit("request", { taskId: ctx.taskId, host, url, attempt: retriesUsed });

      let response;
      try {
        response = await withHostSlot(host, () => fetch(url, ctx.init));
      } catch (error) {
        if (isRetryableNetworkError(error) && retriesUsed < maxRetries) {
          await planRetry(ctx, retriesUsed, computeBackoff(retriesUsed), "network-error");
          retriesUsed += 1;
          continue;
        }
        return finish(ctx, {
          ok: false,
          category: isRetryableNetworkError(error) ? RETRY_EXHAUSTED : NETWORK_FATAL,
          attempts: retriesUsed + 1,
          error,
        });
      }

      if (isRetryableStatus(response.status)) {
        if (retriesUsed < maxRetries) {
          await discardBody(response);
          const delayMs =
            parseRetryAfter(response.headers) ?? computeBackoff(retriesUsed);
          await planRetry(ctx, retriesUsed, delayMs, `status-${response.status}`);
          retriesUsed += 1;
          continue;
        }
        return finish(ctx, {
          ok: false,
          category: RETRY_EXHAUSTED,
          attempts: retriesUsed + 1,
          status: response.status,
          response,
        });
      }

      if (response.status >= 400) {
        return finish(ctx, {
          ok: false,
          category: FATAL_HTTP,
          attempts: retriesUsed + 1,
          status: response.status,
          response,
        });
      }

      return finish(ctx, {
        ok: true,
        category: SUCCESS,
        attempts: retriesUsed + 1,
        status: response.status,
        response,
      });
    }
  }

  async function planRetry(ctx, retriesUsed, delayMs, reason) {
    stats.retries += 1;
    events.emit("retry", {
      taskId: ctx.taskId,
      host: ctx.host,
      attempt: retriesUsed + 1,
      delayMs,
      reason,
      category: "retryable",
    });
    await sleep(delayMs);
  }

  /** Build the outcome, update counters, emit task-end. Single funnel. */
  function finish(ctx, fields) {
    const outcome = {
      taskId: ctx.taskId,
      host: ctx.host,
      url: ctx.url,
      ok: fields.ok,
      category: fields.category,
      attempts: fields.attempts,
    };
    if (fields.status !== undefined) outcome.status = fields.status;
    if (fields.response !== undefined) outcome.response = fields.response;
    if (fields.error !== undefined) outcome.error = fields.error;
    outcome.elapsedMs = Math.max(0, clock() - ctx.startedAt);

    if (fields.category === SUCCESS) stats.succeeded += 1;
    else if (fields.category === BUDGET_SKIPPED) stats.skippedBudget += 1;
    else stats.failed += 1;

    events.emit("task-end", {
      taskId: outcome.taskId,
      host: outcome.host,
      ok: outcome.ok,
      category: outcome.category,
      attempts: outcome.attempts,
      status: outcome.status,
      error: fields.error?.message,
      resumed: false,
      elapsedMs: outcome.elapsedMs,
    });
    return outcome;
  }

  // Manifest persistence is serialized through this queue AND snapshot data
  // is captured INSIDE the chained call, so two workers finishing at the
  // same moment can never write stale views out of order (last-rename-wins
  // would otherwise resurrect an older completion set — lost update).
  let manifestQueue = Promise.resolve();

  function persistManifest() {
    if (!manifestConfig) return Promise.resolve();
    const chained = manifestQueue.then(async () => {
      await saveManifest(manifestConfig.path, {
        version: MANIFEST_VERSION,
        updatedAt: new Date().toISOString(),
        completed: Object.fromEntries(completed),
      });
    });
    // The queue must survive a failed persist: log and continue.
    manifestQueue = chained.catch(() => {});
    return chained.catch((error) => {
      // Non-fatal: the crawl continues, but health consumers must see it.
      stats.manifestErrors += 1;
      events.emit("manifest-error", {
        path: manifestConfig.path,
        error: error.message,
      });
    });
  }

  async function hydrateManifest() {
    const existing = await loadManifest(manifestConfig.path);
    completed = new Map(Object.entries(existing?.completed ?? {}));
    const seeded = manifestConfig.initialCompleted;
    if (seeded) {
      for (const [id, at] of Object.entries(seeded)) {
        if (!completed.has(id)) completed.set(id, at);
      }
    }
  }

  async function runOne(task) {
    const id = task?.id ?? task?.url;
    if (manifestConfig && id != null && completed.has(String(id))) {
      stats.resumed += 1;
      events.emit("task-end", {
        taskId: String(id),
        host: null,
        url: task.url ?? null,
        ok: true,
        category: ALREADY_DONE,
        attempts: 0,
        resumed: true,
      });
      return {
        taskId: String(id),
        host: null,
        url: task.url ?? null,
        ok: true,
        category: ALREADY_DONE,
        attempts: 0,
      };
    }

    const outcome = await executeTask(task);
    if (
      outcome.category === SUCCESS &&
      manifestConfig &&
      id != null
    ) {
      completed.set(String(id), new Date().toISOString());
      await persistManifest();
    }
    return outcome;
  }

  /**
   * Run tasks to completion (or clean budget halt). Resolves with
   * `{ results, summary }`; individual task failures land in results and
   * the `failed` counter, they never reject the run.
   */
  async function run(tasks) {
    if (!Array.isArray(tasks)) {
      throw new TypeError("run(tasks) expects an array of tasks");
    }
    remaining = budget;
    budgetAnnounced = false;
    stats = freshStats();
    if (manifestConfig) await hydrateManifest();
    stats.tasks = tasks.length;

    const results = new Array(tasks.length);
    let cursor = 0;
    const workerCount =
      tasks.length === 0 ? 0 : Math.min(concurrency, tasks.length);
    const workers = Array.from({ length: workerCount }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= tasks.length) return;
        results[index] = await runOne(tasks[index]);
      }
    });
    await Promise.all(workers);
    // Flush any in-flight manifest persist so run() resolving guarantees the
    // checkpoint on disk reflects every completion it reported.
    if (manifestConfig) await manifestQueue;

    const summary = {
      tasks: stats.tasks,
      requestsMade: stats.requestsMade,
      retries: stats.retries,
      succeeded: stats.succeeded,
      resumed: stats.resumed,
      failed: stats.failed,
      skippedBudget: stats.skippedBudget,
      manifestErrors: stats.manifestErrors,
      budgetLimit: budget,
    };
    events.emit("run-end", { summary });
    return { results, summary };
  }

  return { run, events };
}
