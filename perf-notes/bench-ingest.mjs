#!/usr/bin/env node
/**
 * Ingest/storage bench for the perf trials. Offline only — operates on a
 * COPY of a real archive (pass --jsonl <path>); never touches data/.
 *
 * Suites:
 *   load      — JsonlObservationRepository cold load + hash re-verification
 *   appendNew — append N fresh observations to an empty temp archive
 *               (full plan + encode + durable write path)
 *   appendDup — re-append the same observations (plan + dedup rejection,
 *               no writes — the nightly no-op case)
 *   compact   — load + compact a temp copy; reports ms, output bytes, sha256
 *   fpMicro   — fingerprint() throughput over real product/offer payloads
 *   encMicro  — encodeRecord() throughput over real records
 *
 * Usage: node perf-notes/bench-ingest.mjs --jsonl /tmp/ingest-perf/prices.jsonl [--reps 3]
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlObservationRepository } from "../src/repository.js";
import { encodeRecord, fingerprint } from "../src/archive-records.js";

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}
const jsonlPath = argValue("--jsonl", "data/prices.jsonl");
const reps = Number(argValue("--reps", "3"));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function timeMs(fn) {
  const start = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

const results = {};

// ---- load ----
{
  const times = [];
  for (let i = 0; i < reps; i += 1) {
    const repo = new JsonlObservationRepository(jsonlPath);
    times.push(await timeMs(() => repo.stats()));
    if (repo.getLoadDefects().length > 0) {
      console.error("LOAD DEFECTS:", repo.getLoadDefects().length);
    }
  }
  results.loadMs = times;
}

// ---- observations for append benches (materialized once from the archive) ----
const sourceRepo = new JsonlObservationRepository(jsonlPath);
const observations = await sourceRepo.query({});
results.observations = observations.length;

// ---- appendNew: fresh empty archive, all additions land ----
{
  const times = [];
  let recordsWritten = 0;
  for (let i = 0; i < reps; i += 1) {
    const dir = await mkdtemp(join(tmpdir(), "ingest-bench-append-"));
    try {
      const repo = new JsonlObservationRepository(join(dir, "append.jsonl"));
      let added = 0;
      const ms = await timeMs(() => repo.append(observations).then((n) => (added = n)));
      recordsWritten = added;
      times.push(ms);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  results.appendNewMs = times;
  results.appendNewRecords = recordsWritten;
}

// ---- appendDup: re-append into a repo that already holds everything ----
{
  const dir = await mkdtemp(join(tmpdir(), "ingest-bench-dup-"));
  try {
    const repo = new JsonlObservationRepository(join(dir, "dup.jsonl"));
    await repo.append(observations);
    const times = [];
    for (let i = 0; i < reps; i += 1) {
      times.push(await timeMs(() => repo.append(observations)));
    }
    results.appendDupMs = times;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---- compact ----
{
  const times = [];
  let outBytes = 0;
  let outSha = "";
  for (let i = 0; i < reps; i += 1) {
    const dir = await mkdtemp(join(tmpdir(), "ingest-bench-compact-"));
    const target = join(dir, "compact.jsonl");
    try {
      const { copyFileSync } = await import("node:fs");
      copyFileSync(jsonlPath, target);
      const repo = new JsonlObservationRepository(target);
      let ms = await timeMs(() => repo.stats()); // load
      ms += await timeMs(() => repo.compact());
      times.push(ms);
      outBytes = (await readFile(target)).length;
      outSha = createHash("sha256").update(await readFile(target)).digest("hex");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  results.compactMs = times;
  results.compactOutBytes = outBytes;
  results.compactOutSha256 = outSha;
}

// ---- fingerprint micro: real payloads, streamed from the file ----
{
  const lines = readFileSync(jsonlPath, "utf8").split("\n");
  const payloads = [];
  for (const line of lines) {
    if (!line) continue;
    const record = JSON.parse(line);
    if (record.type === "product" || record.type === "offer" || record.type === "store") {
      payloads.push(record.data);
    }
  }
  const start = process.hrtime.bigint();
  let sink = 0;
  for (const payload of payloads) sink += fingerprint(payload).length;
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  results.fpMicro = {
    payloads: payloads.length,
    ms: Number(ms.toFixed(1)),
    sink,
  };
}

// ---- encodeRecord micro ----
{
  const lines = readFileSync(jsonlPath, "utf8").split("\n").filter((line) => line !== "");
  const start = process.hrtime.bigint();
  let sink = 0;
  for (const line of lines) sink += encodeRecord(JSON.parse(line)).length;
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  results.encMicro = { records: lines.length, ms: Number(ms.toFixed(1)), sink };
}

console.log(JSON.stringify(results, null, 2));
console.error(
  `medians: load=${median(results.loadMs).toFixed(0)}ms ` +
    `appendNew=${median(results.appendNewMs).toFixed(0)}ms (${results.appendNewRecords} recs) ` +
    `appendDup=${median(results.appendDupMs).toFixed(0)}ms ` +
    `compact=${median(results.compactMs).toFixed(0)}ms out=${results.compactOutBytes}B`,
);
