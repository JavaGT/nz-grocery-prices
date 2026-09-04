#!/usr/bin/env node
/**
 * BREADTH-3 — The Warehouse grocery-catalogue breadth collector.
 *
 * Walks `search/updategrid?cgid=…` via curl/execFile (no bare fetch, no
 * shell strings).  Default cgid is the grocery tree
 * (`foodhouseholdpets-fooddrink`, ~1,123 products).
 *
 * Records through PriceArchive as offer revisions only. Resume via
 * checkpoint manifest (<file>.breadth-manifest.json).
 *
 * Usage:
 *   node scripts/warehouse-breadth.js [--cgid <id>] [--file <jsonl>]
 *       [--delay-ms 3000] [--budget 400]
 */

import { PriceArchive } from "../src/archive.js";
import { JsonlObservationRepository } from "../src/repository.js";
import { createCurlTransport, crawlCgid } from "../src/adapters/warehouse-breadth.js";
import { loadManifest, saveManifest } from "./lib/crawler.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const DEFAULT_CGID = "foodhouseholdpets-fooddrink";
export const DEFAULT_FILE = "data/breadth-pilot-tw.jsonl";
export const DEFAULT_DELAY_MS = 3000;
export const DEFAULT_BUDGET = 400;
// Nightly health floor: the grocery tree held ~1,123 products when
// validated (BREADTH-3); a run collecting far fewer than half of that
// means the parser or a block page is eating the catalogue.
export const DEFAULT_MIN_EXPECTED_PRODUCTS = 500;
const LIVE_ARCHIVE_FALLBACK = "data/prices.jsonl";
const MANIFEST_SUFFIX = ".breadth-manifest.json";
const MANIFEST_VERSION = 1;

/**
 * Refuse to breadth-collect into the live archive by accident.
 */
export function assertNotLiveArchive(file, { forceLive = false } = {}) {
  const candidate = resolve(file);
  const live = resolve(process.env.ARCHIVE_FILE ?? LIVE_ARCHIVE_FALLBACK);
  if (candidate === live && !forceLive) {
    throw new Error(
      `Refusing to breadth-collect into ${file}: that resolves to the live ` +
        `archive. Breadth pilots write ${DEFAULT_FILE}; pass --force-live ` +
        `only with an explicit owner decision.`,
    );
  }
}

/**
 * Parse CLI argv into options.
 */
export function parseArgs(argv) {
  const options = {
    cgid: DEFAULT_CGID,
    file: DEFAULT_FILE,
    delayMs: DEFAULT_DELAY_MS,
    budget: DEFAULT_BUDGET,
    minExpectedProducts: DEFAULT_MIN_EXPECTED_PRODUCTS,
    resume: false,
    forceLive: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) {
        throw new TypeError(`${arg} requires a value`);
      }
      return argv[index];
    };
    switch (arg) {
      case "--cgid":
        options.cgid = value();
        break;
      case "--file":
        options.file = value();
        break;
      case "--delay-ms":
        options.delayMs = Number(value());
        break;
      case "--budget":
        options.budget = Number(value());
        break;
      case "--min-expected-products":
        options.minExpectedProducts = Number(value());
        break;
      case "--resume":
        options.resume = true;
        break;
      case "--force-live":
        options.forceLive = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new TypeError(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    throw new TypeError("--delay-ms must be a non-negative number");
  }
  if (!Number.isInteger(options.budget) || options.budget < 1) {
    throw new TypeError("--budget must be a positive integer");
  }
  if (
    !Number.isInteger(options.minExpectedProducts) ||
    options.minExpectedProducts < 0
  ) {
    throw new TypeError("--min-expected-products must be a non-negative integer");
  }
  return options;
}

/**
 * Run a Warehouse breadth collection.
 */
export async function runCollection(options = {}) {
  const {
    cgid = DEFAULT_CGID,
    file = DEFAULT_FILE,
    delayMs = DEFAULT_DELAY_MS,
    budget = DEFAULT_BUDGET,
    minExpectedProducts = DEFAULT_MIN_EXPECTED_PRODUCTS,
    resume = false,
    forceLive = false,
    observedAt = new Date().toISOString(),
    transport = createCurlTransport(),
    log = (msg) => console.log(msg),
    collectWarning = (msg) => console.error(`warn: ${msg}`),
    clock = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  assertNotLiveArchive(file, { forceLive });
  const manifestPath = `${resolve(file)}${MANIFEST_SUFFIX}`;

  // Resume state. Fresh by default: a manifest left by a previous COMPLETE
  // run must not skip the next nightly crawl (that recorded nothing and
  // reported healthy — the silent stall that emptied this lane for the
  // Sep-2026 pilot nights). The archive dedupes unchanged prices, so
  // re-walking every night is the intended behaviour. --resume opts into
  // loading prior checkpoints to recover a crashed manual run.
  const stored = resume ? await loadManifest(manifestPath) : null;
  const completed = new Map(Object.entries(stored?.completed ?? {}));
  const persistManifest = () =>
    saveManifest(manifestPath, {
      version: MANIFEST_VERSION,
      updatedAt: new Date().toISOString(),
      completed: Object.fromEntries(completed),
    });

  // Build the store object (national online scope).
  const store = {
    id: "warehouse:national-online",
    retailer: "warehouse",
    name: "The Warehouse Online",
  };

  // Archive for recording.
  const archive = new PriceArchive(new JsonlObservationRepository(file), {
    clock: () => new Date(clock()),
  });
  let addedTotal = 0;
  let manifestPersistFailures = 0;

  // mark-after-RECORD: archive the window's observations, and only then
  // checkpoint its manifest entry (Luna blocker 1 — checkpoint-before-record
  // could permanently skip windows whose data never landed).
  const onWindow = async (taskId, observations) => {
    if (observations.length > 0) {
      addedTotal += await archive.record(observations);
    }
    try {
      await persistManifest();
    } catch (error) {
      manifestPersistFailures += 1;
      collectWarning(
        `checkpoint persist failed for ${taskId}: ${error.message}`,
      );
    }
  };

  log(
    `warehouse-breadth: cgid=${cgid} → ${file} ` +
      `(delay=${delayMs}ms, budget=${budget}, resume=${resume})`,
  );

  // Run the cgid walk. Per-window recording + checkpointing happens via
  // onWindow (mark-after-record); the legacy checkpoint hook is dropped.
  const result = await crawlCgid({
    transport,
    cgid,
    store,
    observedAt,
    delayMs,
    budget,
    completed,
    log,
    collectWarning,
    clock,
    sleep,
    onWindow,
  });

  // Final manifest persist (catches any offsets that were checkpointed
  // during the walk but the async persist is still settling).
  if (completed.size > 0) {
    try {
      await persistManifest();
    } catch (error) {
      manifestPersistFailures += 1;
      collectWarning(
        `manifest persist failed: ${error.message}`,
      );
    }
  }

  const unhealthy =
    result.budgetExhausted ||
    result.circuitOpen ||
    result.driftDetected ||
    result.maxWindowsReached ||
    manifestPersistFailures > 0 ||
    result.uniqueCount < minExpectedProducts;

  const summary = {
    cgid,
    file,
    manifestPath,
    observedAt,
    healthy: !unhealthy,
    manifestPersistFailures,
    uniqueProducts: result.uniqueCount,
    minExpectedProducts,
    pagesFetched: result.pagesFetched,
    pagesWith0Tiles: result.pagesWith0Tiles,
    skippedCompleted: result.skippedCompleted,
    requestsMade: result.requestsMade,
    observationsRecorded: addedTotal,
    ...(result.budgetExhausted ? { budgetExhausted: true } : {}),
    ...(result.circuitOpen
      ? { circuitOpen: true, circuitReason: result.circuitReason }
      : {}),
    ...(result.driftDetected ? { driftDetected: true } : {}),
    ...(result.maxWindowsReached ? { maxWindowsReached: true } : {}),
    warnings: result.warnings,
  };
  return summary;
}

// ---- CLI ------------------------------------------------------------------

function printHelp() {
  console.log(`Usage:
  node scripts/warehouse-breadth.js [--cgid <id>] [--file <jsonl>]
      [--delay-ms N] [--budget N] [--resume]

The Warehouse grocery-catalogue breadth collector (BREADTH-3).
Walks updategrid?cgid= via curl/execFile. Pacing, budget, and
5-failure circuit breaker protect against Cloudflare blocks.

Options:
  --cgid <id>       category ID to walk (default: ${DEFAULT_CGID})
  --file <path>     archive to append offer revisions to
                    (default: ${DEFAULT_FILE})
  --delay-ms N      minimum gap between requests to the same host
                    (default: ${DEFAULT_DELAY_MS})
  --budget N        hard cap on HTTP calls this run;
                    default ${DEFAULT_BUDGET}
  --min-expected-products N
                    fail the run as unhealthy when fewer unique
                    products are collected (default:
                    ${DEFAULT_MIN_EXPECTED_PRODUCTS})
  --resume          load the checkpoint manifest and skip completed
                    offset windows. Default is a fresh walk each run:
                    a completed manifest must not silently stall the
                    nightly lane (unchanged prices dedupe in the
                    archive anyway).
  --force-live      DANGEROUS: allow --file to point at the live archive

Resume: with --resume, completed offset windows are read from
<file>.breadth-manifest.json; every run still SAVES checkpoints there,
so a crashed default run can be recovered with --resume.`);
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [firstArg] = process.argv.slice(2);
  if (firstArg === "--help" || firstArg === "-h") {
    printHelp();
  } else {
    try {
      const options = parseArgs(process.argv.slice(2));
      const summary = await runCollection({ ...options });
      console.log(JSON.stringify(summary, null, 2));
      if (!summary.healthy) process.exitCode = 1;
    } catch (error) {
      console.error(`error: ${error.message}`);
      console.error("Run with --help for usage.");
      process.exitCode = 1;
    }
  }
}