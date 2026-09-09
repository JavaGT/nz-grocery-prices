#!/usr/bin/env node
/**
 * Output-parity harness for the analytics lane. Offline only.
 *
 * Runs the BASELINE analytics (extracted from the trial-base commit into
 * /tmp/analytics-perf/baseline/analytics.js) and the CURRENT analytics (this
 * worktree) over identical observation inputs and asserts byte-identical
 * JSON outputs:
 *   1. real archives at every scale passed via --jsonl (repeatable)
 *   2. a seeded randomized fuzz over edge semantics: price ties, undefined
 *      promo/member cents, promotion windows, member policy, garbage
 *      observedAt, lastSeenAt, duplicate timestamps, cross-retailer grouping
 *   3. parseRequiredAt error messages
 *
 * Usage: node perf-notes/evidence/parity-analytics.mjs \
 *          --jsonl /tmp/analytics-perf/prices.jsonl \
 *          --jsonl /tmp/analytics-perf/merged-40.jsonl \
 *          --jsonl /tmp/analytics-perf/merged-87.jsonl \
 *          --baseline /tmp/analytics-perf/baseline/analytics.js
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { JsonlObservationRepository } from "../../src/repository.js";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}
const jsonlPaths = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--jsonl") jsonlPaths.push(args[i + 1]);
}
const baselinePath = argValue(
  "--baseline",
  "/tmp/analytics-perf/baseline/analytics.js"
);

const baseline = await import(pathToFileURL(baselinePath).href);
const current = await import("../../src/analytics.js");

const DEAL_PARAMS = {
  freshWithinDays: 7,
  baselineDays: 90,
  minSamples: 3,
  minDropPercent: 0,
  includeAllTimeLows: true,
  pricePolicy: "public",
};

const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

let checks = 0;
let failures = 0;
const dumpDir = "/tmp/analytics-perf/parity-dumps";
mkdirSync(dumpDir, { recursive: true });

function compare(label, baselineValue, currentValue) {
  checks++;
  const a = JSON.stringify(baselineValue);
  const b = JSON.stringify(currentValue);
  if (a !== b) {
    failures++;
    const da = digest(baselineValue);
    const db = digest(currentValue);
    console.error(
      `MISMATCH ${label}\n  baseline sha ${da} (${a.length} bytes)\n  current  sha ${db} (${b.length} bytes)`
    );
    writeFileSync(join(dumpDir, `${label}.baseline.json`), a);
    writeFileSync(join(dumpDir, `${label}.current.json`), b);
  }
}

function runAll(mod, observations, at, perProductSets) {
  const sales = mod.calculateSales(observations, { ...DEAL_PARAMS, at });
  const ongoing = mod.calculateOngoingSales(observations, {
    ...DEAL_PARAMS,
    at,
  });
  return {
    sales,
    ongoing,
    feed: mod.toAgentFeed(sales, at, ongoing),
    seriesAll: mod.buildPriceSeries(observations),
    seriesProd: perProductSets.map((set) => mod.buildPriceSeries(set)),
    // non-default parameter shapes exercise other branches
    salesMember: mod.calculateSales(observations, {
      ...DEAL_PARAMS,
      at,
      pricePolicy: "member",
      minDropPercent: 5,
      includeAllTimeLows: false,
      minSamples: 2,
    }),
    ongoingMember: mod.calculateOngoingSales(observations, {
      at,
      freshWithinDays: 1,
      pricePolicy: "member",
      retailer: observations[0]?.store.retailer,
    }),
  };
}

// ---- 1. real archives ----
for (const jsonlPath of jsonlPaths) {
  const tmp = await mkdtemp(join(tmpdir(), "analytics-parity-"));
  try {
    const repo = new JsonlObservationRepository(join(tmp, "copy.jsonl"));
    const { copyFileSync } = await import("node:fs");
    copyFileSync(jsonlPath, join(tmp, "copy.jsonl"));
    const observations = await repo.query({});
    const at = observations.reduce(
      (max, o) => (o.observedAt > max ? o.observedAt : max),
      ""
    );
    const perProductCount = new Map();
    for (const o of observations) {
      perProductCount.set(o.product.id, (perProductCount.get(o.product.id) ?? 0) + 1);
    }
    const busiest = [...perProductCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id]) => observations.filter((o) => o.product.id === id));

    // Run current FIRST, then baseline, on the same objects: if either side
    // mutated its input, the second runner would see changed data and the
    // comparison would catch it as a mismatch.
    const nowResult = runAll(current, observations, at, busiest);
    const baseResult = runAll(baseline, observations, at, busiest);

    for (const key of Object.keys(nowResult)) {
      compare(`${jsonlPath.split("/").pop()}:${key}`, baseResult[key], nowResult[key]);
    }
    console.log(
      `${jsonlPath.split("/").pop()}: ${observations.length} obs, at=${at} — compared`
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// ---- 2. seeded fuzz over edge semantics ----
let seed = 0x2f6e2b1;
function rand() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) % 10000) / 10000;
}
function pick(array) {
  return array[Math.floor(rand() * array.length)];
}
function randomIso(daysFromBase) {
  const base = Date.parse("2026-08-20T12:00:00.000Z");
  return new Date(base + daysFromBase * 86400000 + Math.floor(rand() * 86400000)).toISOString();
}

function randomObservation() {
  const price = {
    regularCents: pick([1000, 1500, 2000, 2000, 999]),
  };
  if (rand() < 0.7) price.promoCents = pick([800, 800, 1500, 1200, undefined]);
  if (rand() < 0.4) price.memberCents = pick([700, 800, 1500, undefined]);
  const observation = {
    product: {
      id: `p${Math.floor(rand() * 40)}`,
      name: `Product ${Math.floor(rand() * 40)}`,
      brand: pick(["A", "B", undefined]),
    },
    store: {
      id: `s${Math.floor(rand() * 6)}`,
      name: `Store ${Math.floor(rand() * 6)}`,
      retailer: pick(["countdown", "newworld", "paknsave"]),
    },
    price,
    observedAt: pick([randomIso(rand() * 30 - 25), randomIso(rand() * 5), "garbage"]),
    isOnSpecial: pick([true, false, undefined]),
  };
  if (rand() < 0.5) {
    const start = rand() * 40 - 30;
    observation.promotion = {
      ...(rand() < 0.8 ? { startsAt: randomIso(start) } : {}),
      ...(rand() < 0.8 ? { endsAt: randomIso(start + rand() * 20) } : {}),
      ...(rand() < 0.5 ? { savePercent: Math.floor(rand() * 50) } : {}),
    };
  }
  if (rand() < 0.4) observation.lastSeenAt = randomIso(rand() * 10 - 5);
  if (price.promoCents === undefined) delete price.promoCents;
  if (price.memberCents === undefined) delete price.memberCents;
  return observation;
}

const fuzzInputs = [];
for (let i = 0; i < 300; i++) {
  const observations = Array.from({ length: 80 }, randomObservation);
  const at = randomIso(rand() * 10 - 5);
  fuzzInputs.push({ observations, at });
}
for (let i = 0; i < fuzzInputs.length; i++) {
  const { observations, at } = fuzzInputs[i];
  // two "busy products" slices
  const slices = [
    observations.filter((o) => o.product.id === "p1"),
    observations.filter((o) => o.product.id === "p2" && o.store.retailer === "countdown"),
  ];
  const nowResult = runAll(current, observations, at, slices);
  const baseResult = runAll(baseline, observations, at, slices);
  for (const key of Object.keys(nowResult)) {
    compare(`fuzz${i}:${key}`, baseResult[key], nowResult[key]);
  }
}

// ---- 3. parseRequiredAt error parity ----
for (const badAt of [undefined, null, 123, "not-a-date", ""]) {
  checks += 2;
  try {
    baseline.calculateSales([], { at: badAt });
    console.error("MISMATCH: baseline did not throw for", badAt);
    failures++;
  } catch (error) {
    try {
      current.calculateSales([], { at: badAt });
      console.error("MISMATCH: current did not throw for", badAt);
      failures++;
    } catch (error2) {
      if (
        error.message !== error2.message ||
        error.constructor !== error2.constructor
      ) {
        failures++;
        console.error(`MISMATCH throw for ${JSON.stringify(badAt)}: "${error.message}" vs "${error2.message}"`);
      }
    }
  }
}

console.log(`\n${checks} comparisons, ${failures} mismatches`);
process.exit(failures === 0 ? 0 : 1);
