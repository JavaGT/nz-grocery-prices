/**
 * Archive one store at a time with optional delay between stores.
 * Continues after a single-store failure so one bad store does not
 * discard the rest of the day's collection.
 *
 * Optional shouldSkip(store) → reason string to skip without hitting the API
 * (e.g. store already observed within max-age window).
 */
export async function archiveEachStore({
  stores,
  collectForStore,
  record,
  delayMs = 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  shouldSkip,
}) {
  if (!Array.isArray(stores)) throw new TypeError("stores must be an array");
  if (typeof collectForStore !== "function") {
    throw new TypeError("collectForStore must be a function");
  }
  if (typeof record !== "function") throw new TypeError("record must be a function");
  if (shouldSkip != null && typeof shouldSkip !== "function") {
    throw new TypeError("shouldSkip must be a function when provided");
  }

  const results = [];
  for (let index = 0; index < stores.length; index += 1) {
    const store = stores[index];
    if (shouldSkip) {
      const reason = await shouldSkip(store);
      if (reason) {
        results.push({
          store: store.name ?? store.id,
          id: store.id,
          ok: true,
          skipped: true,
          reason: String(reason),
          fetched: 0,
          added: 0,
        });
        continue;
      }
    }
    try {
      const observations = await collectForStore(store);
      const list = Array.isArray(observations) ? observations : [];
      const added = await record(list);
      results.push({
        store: store.name ?? store.id,
        id: store.id,
        ok: true,
        fetched: list.length,
        added: typeof added === "number" ? added : 0,
      });
    } catch (error) {
      results.push({
        store: store.name ?? store.id,
        id: store.id,
        ok: false,
        fetched: 0,
        added: 0,
        error: error?.message ? String(error.message) : String(error),
      });
    }
    if (index < stores.length - 1 && delayMs > 0) {
      await sleep(delayMs);
    }
  }
  return results;
}

/** Map adapter listStores() id → archive price_contexts.store_id. */
export function archiveStoreId(store, retailer) {
  const raw = String(store?.id ?? "").trim();
  if (!raw) return "";
  if (raw.includes(":")) return raw;
  if (retailer) return `${retailer}:${raw}`;
  return raw;
}

/**
 * Skip store when archive has an observation newer than maxAgeMs.
 * maxAgeMs <= 0 disables skip. repository needs latestObservationMsForStore(storeId).
 */
export function makeFreshnessSkip({
  repository,
  retailer,
  maxAgeMs,
  nowMs = Date.now(),
}) {
  if (!repository || typeof repository.latestObservationMsForStore !== "function") {
    return undefined;
  }
  const windowMs = Number(maxAgeMs);
  if (!Number.isFinite(windowMs) || windowMs <= 0) return undefined;

  return (store) => {
    const storeId = archiveStoreId(store, retailer);
    if (!storeId) return null;
    const latest = repository.latestObservationMsForStore(storeId);
    if (latest == null) return null;
    const age = nowMs - Number(latest);
    if (age < windowMs) {
      const hours = (age / 3_600_000).toFixed(1);
      return `fresh (${hours}h ago)`;
    }
    return null;
  };
}

export function summarizeStoreResults(results) {
  const collected = results.filter((r) => r.ok && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  const failed = results.filter((r) => !r.ok);
  return {
    stores: results.length,
    succeeded: collected.length,
    skipped: skipped.length,
    failed: failed.length,
    fetched: results.reduce((sum, r) => sum + (r.fetched ?? 0), 0),
    added: results.reduce((sum, r) => sum + (r.added ?? 0), 0),
    results,
  };
}

/** Exit 0 unless every store failed (skips count as non-failure). */
export function exitCodeForStoreResults(summary) {
  if (!summary || summary.stores === 0) return 1;
  if (summary.failed >= summary.stores) return 1;
  return 0;
}
