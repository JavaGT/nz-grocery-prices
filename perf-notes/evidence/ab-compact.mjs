import { mkdtemp, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { JsonlObservationRepository: CurrentRepo } = await import("/Users/server/Development/perf-trial-2026-09-09T100601-ingest/src/repository.js");
const { JsonlObservationRepository: BaselineRepo } = await import("/tmp/ingest-perf/baseline/src/repository.js");
function median(a) { return [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)]; }
async function timeIt(fn) { const t = process.hrtime.bigint(); await fn(); return Number(process.hrtime.bigint() - t) / 1e6; }
async function benchCompact(Repo, src) {
  const dir = await mkdtemp(join(tmpdir(), "ab-compact-"));
  try {
    const target = join(dir, "a.jsonl");
    await copyFile(src, target);
    const repo = new Repo(target);
    await repo.stats();
    return await timeIt(() => repo.compact());
  } finally { await rm(dir, { recursive: true, force: true }); }
}
for (const src of ["/tmp/ingest-perf/prices.jsonl", "/tmp/ingest-perf/breadth-pilot.jsonl"]) {
  const base = [], cur = [];
  for (let i = 0; i < 5; i++) {
    base.push(await benchCompact(BaselineRepo, src));
    cur.push(await benchCompact(CurrentRepo, src));
  }
  console.log("compact", src.split("/").pop().padEnd(22), "baseline", median(base).toFixed(0), "ms | current", median(cur).toFixed(0), "ms | delta", ((median(cur) - median(base)) / median(base) * 100).toFixed(0) + "%");
}
