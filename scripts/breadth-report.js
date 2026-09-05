#!/usr/bin/env node
/**
 * Build an operational report for the most recent breadth-pilot run.
 *
 * This reads the append-only health log and pilot archives only. It never
 * starts a collector and never touches the authoritative prices archive.
 */

import { existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { groupRuns } from "./breadth-pilot-gate.js";

export const DEFAULT_HEALTH_LOG = "/tmp/nz-grocery-breadth.health.jsonl";
export const DEFAULT_DATA_DIR = "data";
export const DEFAULT_REPORT_DIR = "reports";

export const ARCHIVES = [
  { label: "PAK'nSAVE + New World pilot", file: "breadth-pilot.jsonl" },
  { label: "New World pilot", file: "breadth-pilot-nw.jsonl" },
  { label: "FreshChoice pilot", file: "breadth-pilot-fc.jsonl" },
  { label: "The Warehouse pilot", file: "breadth-pilot-tw.jsonl" },
  { label: "Woolworths pilot", file: "breadth-pilot-ww.jsonl" },
];

export const RETAILERS = [
  {
    id: "paknsave",
    label: "PAK'nSAVE",
    archive: "breadth-pilot.jsonl",
    expectedStores: 57,
    storeMode: "physical store pilot",
  },
  {
    id: "newworld",
    label: "New World",
    archive: "breadth-pilot.jsonl",
    expectedStores: 148,
    storeMode: "physical store pilot",
  },
  {
    id: "freshchoice",
    label: "FreshChoice",
    archive: "breadth-pilot-fc.jsonl",
    expectedStores: 76,
    storeMode: "storefront pilot",
  },
  {
    id: "warehouse",
    label: "The Warehouse",
    archive: "breadth-pilot-tw.jsonl",
    expectedStores: null,
    storeMode: "national online catalogue",
  },
  {
    id: "woolworths",
    label: "Woolworths",
    archive: "breadth-pilot-ww.jsonl",
    expectedStores: null,
    storeMode: "one fulfilment context",
  },
];

function emptyStats(file) {
  return {
    file,
    present: false,
    lines: 0,
    invalidLines: 0,
    types: { product: 0, store: 0, offer: 0 },
    products: new Set(),
    offers: new Set(),
    stores: new Set(),
    gtinProducts: new Set(),
    adapters: new Set(),
    observedAtMin: null,
    observedAtMax: null,
  };
}

/** Fold one JSONL line into the running stats (BREADTH-12: O(line) memory). */
function applyLine(stats, line) {
  if (!line.trim()) return;
  stats.lines += 1;
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    stats.invalidLines += 1;
    return;
  }
  // Valid JSON that is not an object (null, 42, "str") is a bad line too.
  if (!record || typeof record !== "object") {
    stats.invalidLines += 1;
    return;
  }
  if (record.type in stats.types) stats.types[record.type] += 1;
  if (record.productId) stats.products.add(record.productId);
  if (record.offerId) stats.offers.add(record.offerId);
  if (record.storeId) stats.stores.add(record.storeId);
  if (record.type === "store" && record.storeId) stats.stores.add(record.storeId);
  if (record.type === "product" && record.data?.gtin) {
    stats.gtinProducts.add(record.productId);
  }
  if (record.data?.source?.adapter) stats.adapters.add(record.data.source.adapter);
  // ISO-8601 UTC timestamps order lexicographically, so string min/max
  // equals the chronological span without keeping every value.
  if (record.observedAt) {
    if (stats.observedAtMin === null || record.observedAt < stats.observedAtMin) {
      stats.observedAtMin = record.observedAt;
    }
    if (stats.observedAtMax === null || record.observedAt > stats.observedAtMax) {
      stats.observedAtMax = record.observedAt;
    }
  }
}

/**
 * Chunked streaming read of a JSONL archive, yielding one line at a time.
 * Lines split on "\n" across chunk boundaries manually — same policy as the
 * repository loader, but without accumulating the whole file.
 */
async function* jsonlLines(filePath) {
  const handle = await open(filePath, "r");
  try {
    const stream = handle.createReadStream({ encoding: "utf8" });
    let pending = "";
    for await (const chunk of stream) {
      const pieces = chunk.split("\n");
      pending += pieces[0];
      for (let index = 1; index < pieces.length; index += 1) {
        yield pending;
        pending = pieces[index];
      }
    }
    if (pending !== "") yield pending;
  } finally {
    await handle.close();
  }
}

/**
 * Read one JSONL pilot archive and return deduplicated corpus statistics.
 * Accepts pre-loaded `text` (tests, small fixtures); production callers use
 * {@link summarizeArchiveStream}, which never holds the whole file.
 */
export function summarizeArchive(file, text = null) {
  const stats = emptyStats(file);
  if (text === null) {
    if (!existsSync(file)) return stats;
    text = readFileSync(file, "utf8");
  }
  stats.present = true;
  for (const line of text.split(/\r?\n/)) {
    applyLine(stats, line);
  }
  return stats;
}

/** Streaming variant of {@link summarizeArchive} for large archives. */
export async function summarizeArchiveStream(file) {
  const stats = emptyStats(file);
  if (!existsSync(file)) return stats;
  stats.present = true;
  for await (const line of jsonlLines(file)) {
    applyLine(stats, line);
  }
  return stats;
}

function mergeStats(statsList) {
  const merged = emptyStats("corpus");
  merged.present = statsList.some((stats) => stats.present);
  for (const stats of statsList) {
    merged.lines += stats.lines;
    merged.invalidLines += stats.invalidLines;
    for (const type of Object.keys(merged.types)) merged.types[type] += stats.types[type];
    for (const value of stats.products) merged.products.add(value);
    for (const value of stats.offers) merged.offers.add(value);
    for (const value of stats.stores) merged.stores.add(value);
    for (const value of stats.gtinProducts) merged.gtinProducts.add(value);
    for (const value of stats.adapters) merged.adapters.add(value);
    if (stats.observedAtMin !== null &&
        (merged.observedAtMin === null || stats.observedAtMin < merged.observedAtMin)) {
      merged.observedAtMin = stats.observedAtMin;
    }
    if (stats.observedAtMax !== null &&
        (merged.observedAtMax === null || stats.observedAtMax > merged.observedAtMax)) {
      merged.observedAtMax = stats.observedAtMax;
    }
  }
  return merged;
}

function retailerFromId(value) {
  return String(value).split(":", 1)[0];
}

function formatNumber(value) {
  return typeof value === "number"
    ? new Intl.NumberFormat("en-NZ").format(value)
    : String(value);
}

function formatDate(value) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en-NZ", {
    timeZone: "Pacific/Auckland",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function nzDate(value) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Pacific/Auckland",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

function latestRun(healthText) {
  const runs = groupRuns(healthText.split(/\r?\n/));
  const stamps = [...runs.keys()].sort((a, b) => Date.parse(a) - Date.parse(b));
  if (stamps.length === 0) return null;
  const stamp = stamps.at(-1);
  return { stamp, entries: runs.get(stamp) };
}

function coverageRows(statsList) {
  const stores = new Set();
  for (const stats of statsList) for (const store of stats.stores) stores.add(store);
  return RETAILERS.map((retailer) => {
    const actual = [...stores].filter((store) => retailerFromId(store) === retailer.id);
    return { ...retailer, actualStores: actual };
  });
}

function statusFor(retailer, run) {
  const entry = run?.entries.find((candidate) => candidate.retailer === retailer.id);
  const summary = entry?.summary ?? {};
  return {
    retailer,
    entry,
    summary,
    healthy: Boolean(entry?.healthy),
  };
}

/** Build the Markdown report from supplied data, making it easy to test. */
export function buildReport({ generatedAt, run, archiveStats }) {
  const corpus = mergeStats(archiveStats);
  const coverage = coverageRows(archiveStats);
  const statuses = RETAILERS.map((retailer) => statusFor(retailer, run));
  const fullyHealthy = statuses.length === run?.entries.length && statuses.every((row) => row.healthy);
  const physical = coverage.filter((row) => row.expectedStores !== null);
  const physicalActual = physical.reduce((sum, row) => sum + row.actualStores.length, 0);
  const physicalExpected = physical.reduce((sum, row) => sum + row.expectedStores, 0);
  const generatedDate = nzDate(generatedAt);

  const statusTable = statuses.map(({ retailer, entry, summary, healthy }) => {
    const result = entry ? (healthy ? "✅ healthy" : "❌ failed") : "⚠️ no record";
    const products = summary.uniqueProducts ?? "—";
    const pages = summary.pagesFetched ?? "—";
    const requests = summary.httpRequestsAdmitted ?? summary.requestsMade ?? "—";
    const added = summary.observationsRecorded ?? "—";
    return `| ${retailer.label} | ${result} | ${formatNumber(products)} | ${formatNumber(pages)} | ${formatNumber(requests)} | ${formatNumber(added)} |`;
  }).join("\n");

  const archiveTable = archiveStats.map((stats) => {
    const label = ARCHIVES.find((archive) => archive.file === basename(stats.file))?.label ?? basename(stats.file);
    return `| ${label} | ${stats.present ? "yes" : "no"} | ${formatNumber(stats.lines)} | ${formatNumber(stats.products.size)} | ${formatNumber(stats.offers.size)} | ${formatNumber(stats.stores.size)} |`;
  }).join("\n");

  const coverageTable = coverage.map((row) => {
    const actual = row.actualStores.length;
    const target = row.expectedStores === null ? "not comparable" : `~${formatNumber(row.expectedStores)}`;
    const percentage = row.expectedStores === null ? "—" : `${((actual / row.expectedStores) * 100).toFixed(1)}%`;
    const contexts = actual === 0 ? "none" : row.actualStores.map((store) => `\`${store}\``).join(", ");
    return `| ${row.label} | ${formatNumber(actual)} | ${target} | ${percentage} | ${row.storeMode} | ${contexts} |`;
  }).join("\n");

  const failures = statuses.filter((row) => !row.healthy).map((row) => row.retailer.label);
  const runResult = run
    ? `${formatDate(run.stamp)} — ${fullyHealthy ? "all five retailer jobs healthy" : `${failures.join(", ")} not healthy`}`
    : "No breadth run is recorded in the health log.";

  return `# Breadth pilot report — ${generatedDate}

Generated: ${formatDate(generatedAt)}  
Previous run: ${runResult}

## Executive summary

- **Run verdict:** ${fullyHealthy ? "PASS — all five configured retailer jobs were healthy." : "FAIL — this was not a complete successful run."}
- **Store coverage:** ${formatNumber(physicalActual)} of approximately ${formatNumber(physicalExpected)} listed physical Foodstuffs/FreshChoice stores (${((physicalActual / physicalExpected) * 100).toFixed(1)}%). This is still a pilot, not an every-store collection.
- **Corpus:** ${formatNumber(corpus.lines - corpus.invalidLines)} parseable JSONL records across ${formatNumber(archiveStats.filter((stats) => stats.present).length)} pilot archives, representing ${formatNumber(corpus.products.size)} unique products, ${formatNumber(corpus.offers.size)} unique offers, and ${formatNumber(corpus.stores.size)} store or fulfilment contexts.

The latest run produced useful additions, but it cannot yet support the claim that data was collected for every store. PAK'nSAVE, New World, and FreshChoice are each represented by one pilot context; Woolworths is one fulfilment context by design, and The Warehouse is national online rather than store-local.

## Previous run results

| Retailer | Result | Products reported | Pages fetched | Requests | Observations added |
|---|---:|---:|---:|---:|---:|
${statusTable}

The health gate requires all five entries to be healthy. The latest gate result is therefore **${fullyHealthy ? "healthy" : "unhealthy"}**. A healthy job means the collector completed its configured pilot scope; it does not mean the retailer's entire physical store network was traversed.

## Corpus overview

| Archive | Present | JSONL records | Unique products | Unique offers | Store contexts |
|---|---:|---:|---:|---:|---:|
${archiveTable}

- Record types: ${formatNumber(corpus.types.product)} products, ${formatNumber(corpus.types.offer)} offers, and ${formatNumber(corpus.types.store)} store records.
- Products with a GTIN in at least one product record: ${formatNumber(corpus.gtinProducts.size)}.
- Observation span: ${formatDate(corpus.observedAtMin)} to ${formatDate(corpus.observedAtMax)}.
- Invalid JSONL lines: ${formatNumber(corpus.invalidLines)}. The report counts them but does not silently treat them as valid data.

## Store coverage

| Retailer | Contexts seen | Approx. listed stores | Coverage | Collection scope | Context IDs |
|---|---:|---:|---:|---|---|
${coverageTable}

The physical-store denominator is approximate and comes from the project's documented retailer footprint (~57 PAK'nSAVE, ~148 New World, ~76 FreshChoice). Woolworths has no public multi-store price API in this collector, so it should be measured as fulfilment-context coverage rather than forced into a store percentage.

## Recommended next steps

1. **Make the pilot healthy before expanding it.** Investigate the repeat PAK'nSAVE/New World mobile API 500s and the FreshChoice timeout/circuit-breaker failures. Keep the health gate failing until a complete run is genuinely healthy.
2. **Finish each pilot catalogue with resume verification.** Re-run failed collectors after their cooldown, use the manifests, and confirm no incomplete-coverage or budget-stop flags remain.
3. **Add explicit all-store orchestration.** Resolve the live store lists, schedule one bounded crawl per physical store, and record per-store success, product count, completeness, and last-success time. Do not infer coverage from one representative store.
4. **Establish operational evidence.** Require at least three consecutive healthy nights, retain the health/error logs, and alert on missing retailer lines, zero-product successes, coverage regressions, or stale manifests.
5. **Only then promote the corpus.** Rebuild the separate projection database from the verified archive, run product matching into the app database, and use the resulting history for price intelligence. Never mix pilot archives into the authoritative archive until their coverage contract is met.

## Evidence and method

- Run evidence: **/tmp/nz-grocery-breadth.health.jsonl** and the breadth run log.
- Corpus evidence: **data/breadth-pilot-*.jsonl** and their manifests.
- This report is read-only with respect to collection: it does not call retailer APIs and does not modify **data/prices.jsonl**.
`;
}

export function parseArgs(argv) {
  const options = {
    healthLog: DEFAULT_HEALTH_LOG,
    dataDir: DEFAULT_DATA_DIR,
    output: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--health-log") options.healthLog = argv[++index];
    else if (arg === "--data-dir") options.dataDir = argv[++index];
    else if (arg === "--output") options.output = argv[++index];
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new TypeError(`Unknown argument: ${arg}`);
  }
  return options;
}

export async function runReport({ healthLog = DEFAULT_HEALTH_LOG, dataDir = DEFAULT_DATA_DIR, output = null, generatedAt = new Date().toISOString() } = {}) {
  const run = existsSync(healthLog) ? latestRun(readFileSync(healthLog, "utf8")) : null;
  const archiveStats = await Promise.all(
    ARCHIVES.map(({ file }) => summarizeArchiveStream(join(dataDir, file))),
  );
  const report = buildReport({ generatedAt, run, archiveStats });
  const reportPath = resolve(output ?? join(DEFAULT_REPORT_DIR, `breadth-report-${nzDate(generatedAt)}.md`));
  mkdirSync(resolve(reportPath, ".."), { recursive: true });
  writeFileSync(reportPath, report);
  return { reportPath, report, run, archiveStats };
}

if (process.argv[1]?.endsWith("breadth-report.js")) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log("Usage: node scripts/breadth-report.js [--health-log path] [--data-dir path] [--output path]");
    } else {
      const result = await runReport(options);
      console.log(JSON.stringify({ reportPath: result.reportPath, previousRun: result.run?.stamp ?? null }, null, 2));
    }
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
