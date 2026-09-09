import { createHash } from "node:crypto";
const CURRENT = "/Users/server/Development/perf-trial-2026-09-09T100601-ingest/src/repository.js";
const BASELINE = "/tmp/ingest-perf/baseline/src/repository.js";
const { JsonlObservationRepository: CurrentRepo } = await import(CURRENT);
const { JsonlObservationRepository: BaselineRepo } = await import(BASELINE);

const queries = [
  {},
  { retailer: "paknsave" },
  { productId: "nonexistent" },
  { from: "2026-08-01", to: "2026-08-15" },
];
for (const archive of ["/tmp/ingest-perf/prices.jsonl", "/tmp/ingest-perf/breadth-pilot.jsonl"]) {
  for (const [label, Repo, tag] of [["base", BaselineRepo, "b"], ["cur", CurrentRepo, "c"]]) {
    const repo = new Repo(archive);
    let all = "";
    for (const q of queries) {
      all += JSON.stringify(await repo.query(q)) + "\n";
    }
    all += JSON.stringify(await repo.stats()) + "\n";
    all += JSON.stringify(await repo.productHistory(
      JSON.parse((await import("node:fs")).readFileSync(archive, "utf8").split("\n")[0]).productId)) + "\n";
    const sha = createHash("sha256").update(all).digest("hex");
    console.log(archive.split("/").pop(), label, sha);
  }
}
