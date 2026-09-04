#!/usr/bin/env node
/**
 * Shared breadth-collector helpers (BREADTH-11).
 *
 * One source of truth for the pure helpers the foodstuffs-mobile and
 * freshchoice collectors both use. No I/O and no retailer clients here —
 * pacing, retries, resume, and observability live in scripts/lib/crawler.js.
 */

import { resolve } from "node:path";

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

/**
 * Dedupe product hits by productId, keeping first sight. Returns the hits
 * that were not already in `seen` (a Map keyed by productId).
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

/** Reconciliation tolerance: warn when |delta| > 0.5% of the target. */
const RECONCILE_TOLERANCE = 0.005;

/**
 * How long a checkpointed page-0 discovery entry stays fresh. After this
 * long every category root is re-discovered, so new products on existing
 * categories surface no later than the TTL (BREADTH-7/BREADTH-8).
 */
export const DEFAULT_DISCOVERY_TTL_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * True when `id` is checkpointed in `completed` (id -> ISO timestamp) within
 * the discovery TTL, so its page-0 fetch can be skipped this run. Unknown or
 * malformed entries are never fresh.
 */
export function discoveryFresh(completed, id, now, ttlMs = DEFAULT_DISCOVERY_TTL_MS) {
  const stamp = completed.get(id);
  if (stamp === undefined) return false;
  const done = Date.parse(stamp);
  if (Number.isNaN(done)) return false;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (Number.isNaN(nowMs)) return false;
  const age = nowMs - done;
  return age >= 0 && age < ttlMs;
}

/**
 * Coverage reconciliation against a catalogue target. `withinTolerance` is
 * false only when a target exists and |delta| exceeds 0.5% of it.
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

/**
 * Resolve --store queries against the store list: exact id or exact
 * (case-insensitive) name wins, else a unique substring match on name or
 * address. Ambiguous or unmatched queries throw with the candidates named.
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
