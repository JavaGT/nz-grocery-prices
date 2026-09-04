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
