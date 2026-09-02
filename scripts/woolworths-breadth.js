#!/usr/bin/env node
/**
 * BREADTH-4 — Woolworths full-catalogue breadth collector.
 *
 * The browse API caps unscoped results, so each department is paged with a
 * deterministic price sort. Products are deduped across departments and
 * recorded into a separate pilot archive. Woolworths' current anonymous
 * session supplies one fulfilment store per run.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PriceArchive } from "../src/archive.js";
import { toWoolworthsObservation, WoolworthsClient } from "../src/adapters/woolworths.js";
import { JsonlObservationRepository } from "../src/repository.js";

export const DEFAULT_FILE = "data/breadth-pilot-ww.jsonl";
export const DEFAULT_DELAY_MS = 3000;
export const DEFAULT_SIZE = 120;
export const DEFAULT_MAX_PAGES = 300;
export const DEFAULT_BUDGET = 400;
const LIVE_ARCHIVE_FALLBACK = fileURLToPath(new URL("../data/prices.jsonl", import.meta.url));
const MIN_EXPECTED_PRODUCTS = 1000;

export function assertNotLiveArchive(file, { forceLive = false } = {}) {
  const candidate = resolve(file);
  const live = resolve(process.env.ARCHIVE_FILE ?? LIVE_ARCHIVE_FALLBACK);
  if (candidate === live && !forceLive) {
    throw new Error(
      `Refusing to breadth-collect into ${file}: that resolves to the live ` +
        "archive. Pass --force-live only with an explicit owner decision.",
    );
  }
}

export function parseArgs(argv) {
  const options = {
    file: DEFAULT_FILE,
    delayMs: DEFAULT_DELAY_MS,
    size: DEFAULT_SIZE,
    maxPages: DEFAULT_MAX_PAGES,
    budget: DEFAULT_BUDGET,
    forceLive: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) throw new TypeError(`${arg} requires a value`);
      return argv[index];
    };
    switch (arg) {
      case "--file": options.file = value(); break;
      case "--delay-ms": options.delayMs = Number(value()); break;
      case "--size": options.size = Number(value()); break;
      case "--max-pages": options.maxPages = Number(value()); break;
      case "--budget": options.budget = Number(value()); break;
      case "--force-live": options.forceLive = true; break;
      case "--help":
      case "-h": options.help = true; break;
      default: throw new TypeError(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(options.delayMs) || options.delayMs < 0) {
    throw new TypeError("--delay-ms must be a non-negative number");
  }
  if (!Number.isInteger(options.size) || options.size < 1) {
    throw new TypeError("--size must be a positive integer");
  }
  if (!Number.isInteger(options.maxPages) || options.maxPages < 1) {
    throw new TypeError("--max-pages must be a positive integer");
  }
  if (!Number.isInteger(options.budget) || options.budget < 1) {
    throw new TypeError("--budget must be a positive integer");
  }
  return options;
}

function departmentItems(payload) {
  const items = Array.isArray(payload)
    ? payload
    : payload?.departments ?? payload?.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Woolworths departments response was empty or malformed");
  }
  return items
    .map((department) => ({
      id: department.id,
      label: department.label ?? department.name,
    }))
    .filter((department) => department.id !== undefined && department.label);
}

function departmentFilter(department) {
  return `Department;${department.id};${department.label};false`;
}

function fulfilmentFrom(result) {
  return result?.context?.fulfilment ?? result?.context;
}

function assertSameStore(current, next) {
  if (!next?.fulfilmentStoreId) {
    throw new Error("Woolworths browse response did not identify its fulfilment store");
  }
  if (current && String(current.fulfilmentStoreId) !== String(next.fulfilmentStoreId)) {
    throw new Error("Woolworths fulfilment store changed during breadth collection");
  }
  return next;
}

export async function runCollection(options = {}) {
  const {
    file = DEFAULT_FILE,
    delayMs = DEFAULT_DELAY_MS,
    size = DEFAULT_SIZE,
    maxPages = DEFAULT_MAX_PAGES,
    budget = DEFAULT_BUDGET,
    minExpectedProducts = MIN_EXPECTED_PRODUCTS,
    forceLive = false,
    observedAt = new Date().toISOString(),
    client = new WoolworthsClient({ cookie: process.env.WOOLWORTHS_COOKIE }),
    sleep = (ms) => new Promise((resolveAfterSleep) => setTimeout(resolveAfterSleep, ms)),
    log = () => {},
  } = options;

  assertNotLiveArchive(file, { forceLive });
  const archive = new PriceArchive(new JsonlObservationRepository(file));
  const departments = departmentItems(await client.listDepartments());
  const seen = new Set();
  let fulfilment;
  let pagesFetched = 0;
  let requestsMade = 1;
  let observationsRecorded = 0;
  let incompleteCoverage = false;
  let budgetExhausted = false;

  const requestPage = async (parameters) => {
    if (requestsMade >= budget) return null;
    if (pagesFetched > 0) await sleep(delayMs);
    const result = await client.listProducts(parameters);
    pagesFetched += 1;
    requestsMade += 1;
    fulfilment = assertSameStore(fulfilment, fulfilmentFrom(result));
    return result;
  };

  departmentLoop: for (const department of departments) {
    const filter = departmentFilter(department);
    let page = 1;
    let totalPages = 1;
    while (page <= totalPages && page <= maxPages) {
      const result = await requestPage({
        target: "browse",
        dasFilter: filter,
        sort: "PriceAsc",
        page,
        size,
      });
      if (!result) {
        budgetExhausted = true;
        incompleteCoverage = true;
        break departmentLoop;
      }
      const items = result.products?.items ?? [];
      const fresh = [];
      for (const product of items) {
        if (!product?.sku || seen.has(String(product.sku))) continue;
        seen.add(String(product.sku));
        const observation = toWoolworthsObservation(product, fulfilment, { observedAt });
        if (observation) fresh.push(observation);
      }
      if (fresh.length > 0) observationsRecorded += await archive.record(fresh);

      const totalItems = Number(result.products?.totalItems);
      const hasKnownTotal = Number.isFinite(totalItems) && totalItems >= 0;
      if (items.length === 0 && totalItems > 0) incompleteCoverage = true;
      totalPages = hasKnownTotal && totalItems > 0
        ? Math.ceil(totalItems / size)
        : items.length === size
          ? maxPages
          : page;
      if (page === maxPages && (!hasKnownTotal || totalItems > page * size)) {
        incompleteCoverage = true;
      }
      page += 1;
    }
    log(`${department.label}: ${seen.size} unique products so far`);
  }

  return {
    file,
    observedAt,
    healthy:
      !incompleteCoverage &&
      !budgetExhausted &&
      pagesFetched > 0 &&
      Boolean(fulfilment) &&
      seen.size >= minExpectedProducts,
    store: fulfilment ? `woolworths:${fulfilment.fulfilmentStoreId}` : null,
    departments: departments.length,
    uniqueProducts: seen.size,
    pagesFetched,
    requestsMade,
    observationsRecorded,
    incompleteCoverage,
    ...(budgetExhausted ? { budgetExhausted: true } : {}),
  };
}

function printHelp() {
  console.log(`Usage:
  node scripts/woolworths-breadth.js [--file <jsonl>] [--delay-ms N]
      [--size N] [--max-pages N] [--budget N]

Woolworths full-catalogue breadth collector. It walks every department using
the browse API and records one anonymous fulfilment-store context.

Defaults: --file ${DEFAULT_FILE}, --delay-ms ${DEFAULT_DELAY_MS},
--size ${DEFAULT_SIZE}, --budget ${DEFAULT_BUDGET}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) printHelp();
    else {
      const summary = await runCollection({ ...options, log: (message) => console.log(message) });
      console.log(JSON.stringify(summary, null, 2));
      if (!summary.healthy) process.exitCode = 1;
    }
  } catch (error) {
    console.log(JSON.stringify({ healthy: false, error: error.message }));
    process.exitCode = 1;
  }
}
