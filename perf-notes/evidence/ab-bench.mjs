// In-process A/B: baseline vs current repository, alternating reps.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { JsonlObservationRepository: CurrentRepo } = await import("/Users/server/Development/perf-trial-2026-09-09T100601-ingest/src/repository.js");
const { JsonlObservationRepository: BaselineRepo } = await import("/tmp/ingest-perf/baseline/src/repository.js");

const source = new CurrentRepo("/tmp/ingest-perf/prices.jsonl");
const observations = await source.query({});

function median(a) { return [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]; }
async function timeIt(fn) {
  const t = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
}

async function benchAppend(Repo) {
  const dir = await mkdtemp(join(tmpdir(), "ab-append-"));
  try {
    const repo = new Repo(join(dir, "a.jsonl"));
    return await timeIt(() => repo.append(observations));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function benchDup(Repo) {
  const dir = await mkdtemp(join(tmpdir(), "ab-dup-"));
  try {
    const repo = new Repo(join(dir, "a.jsonl"));
    await repo.append(observations);
    return await timeIt(() => repo.append(observations));
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function benchLoad(Repo) {
  const repo = new Repo("/tmp/ingest-perf/prices.jsonl");
  return timeIt(() => repo.stats());
}

const REPS = 7;
for (const [name, fn] of [["load", benchLoad], ["appendNew", benchAppend], ["appendDup", benchDup]]) {
  const base = [], cur = [];
  for (let i = 0; i < REPS; i++) {
    // warmup + alternate order to cancel drift
    base.push(await fn(BaselineRepo));
    cur.push(await fn(CurrentRepo));
  }
  console.log(name.padEnd(10), "baseline", median(base).toFixed(0).padStart(4), "ms | current", median(cur).toFixed(0).padStart(4), "ms | delta", ((median(cur) - median(base)) / median(base) * 100).toFixed(0) + "%");
}
