// Compact parity: baseline vs current implementation on archive copies.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, copyFile, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
const run = promisify(execFile);

async function compactWith(entrypoint, archive) {
  const dir = await mkdtemp(join(tmpdir(), "compact-parity-"));
  try {
    const target = join(dir, "a.jsonl");
    await copyFile(archive, target);
    const before = (await readFile(target)).length;
    const out = await run("node", [entrypoint, "--file", target]);
    const bytes = (await readFile(target)).length;
    const sha = createHash("sha256").update(await readFile(target)).digest("hex");
    return { before, bytes, sha, stdout: out.stdout.trim().split("\n").slice(-6).join(" ") };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

for (const archive of ["/tmp/ingest-perf/prices.jsonl", "/tmp/ingest-perf/breadth-pilot.jsonl"]) {
  const base = await compactWith("/tmp/ingest-perf/baseline/scripts/compact-archive.js", archive);
  const cur = await compactWith("/Users/server/Development/perf-trial-2026-09-09T100601-ingest/scripts/compact-archive.js", archive);
  console.log(archive.split("/").pop());
  console.log("  baseline:", JSON.stringify(base));
  console.log("  current :", JSON.stringify(cur));
  console.log("  MATCH:", base.sha === cur.sha && base.bytes === cur.bytes && base.before === cur.before);
}
