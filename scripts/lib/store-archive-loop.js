/**
 * Archive one store at a time with optional delay between stores.
 * Continues after a single-store failure so one bad store does not
 * discard the rest of the day's collection.
 */
export async function archiveEachStore({
  stores,
  collectForStore,
  record,
  delayMs = 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!Array.isArray(stores)) throw new TypeError("stores must be an array");
  if (typeof collectForStore !== "function") {
    throw new TypeError("collectForStore must be a function");
  }
  if (typeof record !== "function") throw new TypeError("record must be a function");

  const results = [];
  for (let index = 0; index < stores.length; index += 1) {
    const store = stores[index];
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

export function summarizeStoreResults(results) {
  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  return {
    stores: results.length,
    succeeded: succeeded.length,
    failed: failed.length,
    fetched: results.reduce((sum, r) => sum + (r.fetched ?? 0), 0),
    added: results.reduce((sum, r) => sum + (r.added ?? 0), 0),
    results,
  };
}

/** Exit 0 if at least one store succeeded; exit 1 if none did (or zero stores). */
export function exitCodeForStoreResults(summary) {
  if (!summary || summary.stores === 0) return 1;
  return summary.succeeded > 0 ? 0 : 1;
}
