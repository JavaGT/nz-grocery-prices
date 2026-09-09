#!/usr/bin/env node
/**
 * Interleaved in-process A/B bench for analytics modules. Machine noise from
 * sibling lanes cancels: baseline and variant run alternately in ONE process
 * over the SAME observation objects; medians are compared.
 *
 * Usage:
 *   node perf-notes/evidence/ab-analytics.mjs --a /tmp/analytics-perf/baseline/analytics.js \
 *     --b ../src/analytics.js --jsonl /tmp/analytics-perf/merged-87.jsonl [--reps 15]
 * (module paths relative to this script's perf-notes/evidence directory or absolute)
 */

import { pathToFileURL } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonlObservationRepository } from "../../src/repository.js";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}
const here = dirname(fileURLToPath(import.meta.url));
function modulePath(p) {
  return isAbsolute(p) ? p : resolve(here, p);
}
const pathA = modulePath(argValue("--a", "/tmp/analytics-perf/baseline/analytics.js"));
const pathB = modulePath(argValue("--b", "../../src/analytics.js"));
const jsonlPath = argValue("--jsonl", "/tmp/analytics-perf/merged-87.jsonl");
const reps = Number(argValue("--reps", "15"));

const modA = await import(pathToFileURL(pathA).href);
const modB = await import(pathToFileURL(pathB).href);

const DEAL_PARAMS = {
  freshWithinDays: 7,
  baselineDays: 90,
  minSamples: 3,
  minDropPercent: 0,
  includeAllTimeLows: true,
  pricePolicy: "public",
};

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function timeMs(fn) {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

const tmp = await mkdtemp(join(tmpdir(), "analytics-ab-"));
try {
  const repo = new JsonlObservationRepository(join(tmp, "copy.jsonl"));
  copyFileSync(jsonlPath, join(tmp, "copy.jsonl"));
  const observations = await repo.query({});
  const at = observations.reduce(
    (max, o) => (o.observedAt > max ? o.observedAt : max),
    ""
  );

  const times = { a: { sales: [], ongoing: [], series: [] }, b: { sales: [], ongoing: [], series: [] } };
  let outA;
  let outB;
  // warmup both
  for (let i = 0; i < 3; i++) {
    modA.calculateSales(observations, { ...DEAL_PARAMS, at });
    modB.calculateSales(observations, { ...DEAL_PARAMS, at });
  }
  for (let rep = 0; rep < reps; rep++) {
    // alternate order each rep so warmup/JIT ordering doesn't favor one side
    const first = rep % 2 === 0 ? modA : modB;
    const second = first === modA ? modB : modA;
    const keyFirst = first === modA ? "a" : "b";
    const keySecond = keyFirst === "a" ? "b" : "a";

    times[keyFirst].sales.push(timeMs(() =>
      first.calculateSales(observations, { ...DEAL_PARAMS, at })));
    times[keySecond].sales.push(timeMs(() =>
      second.calculateSales(observations, { ...DEAL_PARAMS, at })));
    times[keyFirst].ongoing.push(timeMs(() =>
      first.calculateOngoingSales(observations, { ...DEAL_PARAMS, at })));
    times[keySecond].ongoing.push(timeMs(() =>
      second.calculateOngoingSales(observations, { ...DEAL_PARAMS, at })));
    times[keyFirst].series.push(timeMs(() => first.buildPriceSeries(observations)));
    times[keySecond].series.push(timeMs(() => second.buildPriceSeries(observations)));

    outA = modA.calculateSales(observations, { ...DEAL_PARAMS, at });
    outB = modB.calculateSales(observations, { ...DEAL_PARAMS, at });
  }

  // sanity: byte-identical outputs in-process
  const digest = (v) => JSON.stringify(v);
  const identical =
    digest(outA) === digest(outB) &&
    digest(modA.calculateOngoingSales(observations, { ...DEAL_PARAMS, at })) ===
      digest(modB.calculateOngoingSales(observations, { ...DEAL_PARAMS, at })) &&
    digest(modA.buildPriceSeries(observations)) ===
      digest(modB.buildPriceSeries(observations));

  const report = { jsonl: jsonlPath, observations: observations.length, reps, outputsIdentical: identical };
  for (const key of ["a", "b"]) {
    report[key] = {
      salesMs: +median(times[key].sales).toFixed(2),
      ongoingMs: +median(times[key].ongoing).toFixed(2),
      seriesMs: +median(times[key].series).toFixed(2),
    };
  }
  report.bDeltaPct = {
    sales: +(((report.b.salesMs - report.a.salesMs) / report.a.salesMs) * 100).toFixed(1),
    ongoing: +(((report.b.ongoingMs - report.a.ongoingMs) / report.a.ongoingMs) * 100).toFixed(1),
    series: +(((report.b.seriesMs - report.a.seriesMs) / report.a.seriesMs) * 100).toFixed(1),
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  await rm(tmp, { recursive: true, force: true });
}
