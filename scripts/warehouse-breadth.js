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
    forceLive = false,
    observedAt = new Date().toISOString(),
    log = (msg) => console.log(msg),
    collectWarning = (msg) => console.error(`warn: ${msg}`),
    clock = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = options;

  assertNotLiveArchive(file, { forceLive });
  const manifestPath = `${resolve(file)}${MANIFEST_SUFFIX}`;

  // Resume state.
  const stored = await loadManifest(manifestPath);
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

  // Build the curl transport (production: real curl via execFile).
  const transport = createCurlTransport();

  // Archive for recording.
  const archive = new PriceArchive(new JsonlObservationRepository(file), {
    clock: () => new Date(clock()),
  });
  let addedTotal = 0;
  let manifestPersistFailures = 0;

  const commitWave = async (obs) => {
    if (obs.length > 0) {
      addedTotal += await archive.record(obs);
    }
  };

  log(
    `warehouse-breadth: cgid=${cgid} → ${file} ` +
      `(delay=${delayMs}ms, budget=${budget})`,
  );

  // BLOCKER 1 — wire the checkpoint callback so crawlCgid persists the
  // manifest after every successfully processed offset window.
  const checkpoint = (taskId) => {
    persistManifest().catch((error) => {
      manifestPersistFailures += 1;
      collectWarning(
        `checkpoint persist failed for ${taskId}: ${error.message}`,
      );
    });
  };

  // Run the cgid walk.
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
    checkpoint,
  });

  // Commit observations for the entire cgid walk.
  await commitWave(result.observations);

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
    manifestPersistFailures > 0;

  const summary = {
    cgid,
    file,
    manifestPath,
    observedAt,
    healthy: !unhealthy,
    manifestPersistFailures,
    uniqueProducts: result.uniqueCount,
    pagesFetched: result.pagesFetched,
    pagesWith0Tiles: result.pagesWith0Tiles,
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
      [--delay-ms N] [--budget N]

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
  --force-live      DANGEROUS: allow --file to point at the live archive

Resume: completed offset windows are checkpointed in
<file>.breadth-manifest.json; re-running skips recorded offsets.`);
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