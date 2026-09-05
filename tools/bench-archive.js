#!/usr/bin/env node
// Library-level benchmark: loads the real JSONL archive through
// JsonlObservationRepository (the path the hosted app's public search/history
// uses) and reports load time, peak RSS, and a full calculateSales pass.
// Usage: node tools/bench-archive.js [--jsonl <path>] [--passes 3]
// READ-ONLY: never appends or compacts the archive.

import { statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (n, d) => { let i = args.indexOf(n); return i >= 0 ? args[++i] : d; };
const jsonl = argOf('--jsonl', join(ROOT, 'data', 'prices.jsonl'));
const passes = parseInt(argOf('--passes', '3'), 10);

const { JsonlObservationRepository } = await import(join(ROOT, 'src', 'repository.js'));
const { calculateSales } = await import(join(ROOT, 'src', 'analytics.js'));

const rssMB = () => process.memoryUsage.rss() / 1048576;

const sizeMB = statSync(jsonl).size / 1048576;
const repo = new JsonlObservationRepository(jsonl);

const t0 = performance.now();
const observations = await repo.query({});
const loadMs = performance.now() - t0;
const afterLoadRSS = rssMB();

const passTimes = [];
let salesCount = 0;
const at = new Date().toISOString();
for (let i = 0; i < passes; i++) {
  const t = performance.now();
  const sales = calculateSales(observations, {
    at,
    freshWithinDays: 7,
    baselineDays: 90,
    minSamples: 3,
    includeAllTimeLows: true,
    pricePolicy: 'public',
  });
  passTimes.push(performance.now() - t);
  salesCount = sales.length;
}

console.log(JSON.stringify({
  archive: jsonl,
  archiveMB: +sizeMB.toFixed(1),
  observations: observations.length,
  loadMs: +loadMs.toFixed(0),
  rssAfterLoadMB: +afterLoadRSS.toFixed(0),
  calculateSalesMs: passTimes.map(t => +t.toFixed(0)),
  dealsFound: salesCount,
}, null, 2));
