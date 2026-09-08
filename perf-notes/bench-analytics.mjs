#!/usr/bin/env node
/**
 * Analytics bench for the perf trials. Offline only — operates on a COPY of
 * a real archive (pass --jsonl <path>); never touches data/.
 *
 * Suites:
 *   load        — JsonlObservationRepository load + query({}) materialization
 *                 (the realistic observation input for every analytics pass)
 *   sales       — calculateSales over the full observation set with the
 *                 deal-materialization parameter set (rebuild-time workload)
 *   ongoing     — calculateOngoingSales, same params (rebuild-time workload)
 *   agentFeed   — toAgentFeed over the sales+ongoing outputs
 *   seriesAll   — buildPriceSeries over the full observation set (aggregate)
 *   seriesProd  — buildPriceSeries for the 5 busiest products (per-product
 *                 request path shape: query per product, series per product)
 *
 * Usage: node perf-notes/bench-analytics.mjs --jsonl /tmp/analytics-perf/prices.jsonl [--reps 5]
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlObservationRepository } from "../src/repository.js";
import {
  buildPriceSeries,
  calculateOngoingSales,
  calculateSales,
  toAgentFeed,
} from "../src/analytics.js";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}
const jsonlPath = argValue("--jsonl", "data/prices.jsonl");
const reps = Number(argValue("--reps", "5"));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function timeMs(fn) {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

// Same parameter set the rebuild-time materialization pins (DEAL_SIGNAL_PARAMS
// in src/sqlite/deal-materialization.js) — the production-scale workload.
const DEAL_PARAMS = {
  freshWithinDays: 7,
  baselineDays: 90,
  minSamples: 3,
  minDropPercent: 0,
  includeAllTimeLows: true,
  pricePolicy: "public",
};

const results = { jsonl: jsonlPath, reps };

// ---- load + materialize (one-time; analytics timed against its output) ----
const tmp = await mkdtemp(join(tmpdir(), "analytics-bench-"));
try {
  const repo = new JsonlObservationRepository(join(tmp, "copy.jsonl"));
  const { copyFileSync } = await import("node:fs");
  copyFileSync(jsonlPath, join(tmp, "copy.jsonl"));
  let loadTimes = [];
  let observations;
  let at;
  for (let i = 0; i < reps; i++) {
    const start = process.hrtime.bigint();
    observations = await repo.query({});
    loadTimes.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  results.loadQueryMs = median(loadTimes);
  results.observationCount = observations.length;

  // Anchor `at` at the newest observation: the nightly rebuild evaluates a
  // fresh archive, whereas wall-clock "now" can be arbitrarily stale relative
  // to the data and would filter every sale out of the bench entirely.
  at = observations.reduce(
    (max, o) => (o.observedAt > max ? o.observedAt : max),
    ""
  );
  results.at = at;

  // Busiest products by observation count (per-product series workload).
  const perProduct = new Map();
  for (const o of observations) {
    perProduct.set(o.product.id, (perProduct.get(o.product.id) ?? 0) + 1);
  }
  const busiest = [...perProduct.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
  results.busiestProducts = busiest.map(([id, count]) => ({ id, count }));
  const busiestSets = busiest.map(([id]) =>
    observations.filter((o) => o.product.id === id)
  );

  // ---- analytics passes (timed) ----
  const salesTimes = [];
  const ongoingTimes = [];
  const feedTimes = [];
  const seriesAllTimes = [];
  const seriesProdTimes = [];
  let sales;
  let ongoing;
  let series;
  for (let i = 0; i < reps; i++) {
    salesTimes.push(timeMs(() => {
      sales = calculateSales(observations, { ...DEAL_PARAMS, at });
    }));
    ongoingTimes.push(timeMs(() => {
      ongoing = calculateOngoingSales(observations, { ...DEAL_PARAMS, at });
    }));
    feedTimes.push(timeMs(() => {
      toAgentFeed(sales, at, ongoing);
    }));
    seriesAllTimes.push(timeMs(() => {
      series = buildPriceSeries(observations);
    }));
    seriesProdTimes.push(timeMs(() => {
      for (const set of busiestSets) buildPriceSeries(set);
    }));
  }

  results.salesMs = median(salesTimes);
  results.salesCount = sales.length;
  results.ongoingMs = median(ongoingTimes);
  results.ongoingCount = ongoing.length;
  results.agentFeedMs = median(feedTimes);
  results.seriesAllMs = median(seriesAllTimes);
  results.seriesAllSeriesCount = series.length;
  results.seriesProdMs = median(seriesProdTimes);
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(JSON.stringify(results, null, 2));
