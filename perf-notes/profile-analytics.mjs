#!/usr/bin/env node
/**
 * CPU-profile driver for the analytics passes. Run with:
 *   node --cpu-prof --cpu-prof-dir=/tmp/analytics-perf/prof perf-notes/profile-analytics.mjs \
 *     --jsonl /tmp/analytics-perf/merged-87.jsonl
 * Loads the archive once, then runs calculateSales + calculateOngoingSales +
 * buildPriceSeries + toAgentFeed in a loop so the profiler sees only
 * analytics work (load happens before the loop).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { copyFileSync } from "node:fs";
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
const loops = Number(argValue("--loops", "30"));

const DEAL_PARAMS = {
  freshWithinDays: 7,
  baselineDays: 90,
  minSamples: 3,
  minDropPercent: 0,
  includeAllTimeLows: true,
  pricePolicy: "public",
};

const tmp = await mkdtemp(join(tmpdir(), "analytics-prof-"));
try {
  const repo = new JsonlObservationRepository(join(tmp, "copy.jsonl"));
  copyFileSync(jsonlPath, join(tmp, "copy.jsonl"));
  const observations = await repo.query({});
  const at = observations.reduce(
    (max, o) => (o.observedAt > max ? o.observedAt : max),
    ""
  );

  // warmup
  for (let i = 0; i < 3; i++) {
    calculateSales(observations, { ...DEAL_PARAMS, at });
    calculateOngoingSales(observations, { ...DEAL_PARAMS, at });
    buildPriceSeries(observations);
  }

  const t0 = process.hrtime.bigint();
  let sales;
  let ongoing;
  for (let i = 0; i < loops; i++) {
    sales = calculateSales(observations, { ...DEAL_PARAMS, at });
    ongoing = calculateOngoingSales(observations, { ...DEAL_PARAMS, at });
    buildPriceSeries(observations);
    toAgentFeed(sales, at, ongoing);
  }
  console.log(
    JSON.stringify({
      observations: observations.length,
      loops,
      totalMs: Number(process.hrtime.bigint() - t0) / 1e6,
      salesCount: sales.length,
      ongoingCount: ongoing.length,
    })
  );
} finally {
  await rm(tmp, { recursive: true, force: true });
}
