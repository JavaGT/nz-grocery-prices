// Append parity: baseline vs current repository must produce byte-identical
// archives for the same observation stream (single batch + chunked batches).
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CURRENT = "/Users/server/Development/perf-trial-2026-09-09T100601-ingest/src/repository.js";
const BASELINE = "/tmp/ingest-perf/baseline/src/repository.js";

const { JsonlObservationRepository: CurrentRepo } = await import(CURRENT);
process.env.NODE_ENV = "test";
// Baseline import must not share module state; use a query param to bust the module cache.
const { JsonlObservationRepository: BaselineRepo } = await import(BASELINE);

// Observations via the current query path (behavior-identical to baseline per lib lane).
const source = new CurrentRepo("/tmp/ingest-perf/prices.jsonl");
const observations = await source.query({});

async function runAppend(Repo, mode) {
  const dir = await mkdtemp(join(tmpdir(), "append-parity-"));
  try {
    const repo = new Repo(join(dir, "out.jsonl"));
    if (mode === "single") {
      await repo.append(observations);
    } else {
      for (let i = 0; i < observations.length; i += 100) {
        await repo.append(observations.slice(i, i + 100));
      }
    }
    const bytes = await readFile(join(dir, "out.jsonl"));
    return { sha: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

for (const mode of ["single", "chunked"]) {
  const base = await runAppend(BaselineRepo, mode);
  const cur = await runAppend(CurrentRepo, mode);
  console.log(mode, JSON.stringify({ base, cur, MATCH: base.sha === cur.sha }));
}
