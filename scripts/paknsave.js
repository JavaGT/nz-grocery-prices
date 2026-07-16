#!/usr/bin/env node

import { PriceArchive } from "../src/archive.js";
import { NewWorldClient, PaknsaveClient } from "../src/adapters/foodstuffs.js";
import { JsonlObservationRepository } from "../src/repository.js";
import {
  archiveEachStore,
  exitCodeForStoreResults,
  summarizeStoreResults,
} from "./lib/store-archive-loop.js";

const isNewWorld = process.env.FOODSTUFFS_BANNER === "newworld";
const retailer = isNewWorld ? "newworld" : "paknsave";
const retailerName = isNewWorld ? "New World" : "PAK'nSAVE";
const executable = isNewWorld ? "newworld" : "paknsave";
const client = isNewWorld ? new NewWorldClient() : new PaknsaveClient();
const [command = "help", ...args] = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function hasFlag(name) {
  return args.includes(name);
}

function positional() {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith("--")) {
      // Flags without values (e.g. --all-stores) consume only themselves.
      if (args[index + 1] === undefined || args[index + 1].startsWith("--")) continue;
      index += 1;
      continue;
    }
    values.push(args[index]);
  }
  return values;
}

async function resolveStore(value) {
  if (!value) throw new Error("Provide a store name or UUID");
  const allStores = await client.listStores();
  const exact = allStores.find(
    (store) => store.id === value || store.name.toLowerCase() === value.toLowerCase(),
  );
  if (exact) return exact;

  const matches = await client.listStores({ query: value });
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new Error(`No ${retailerName} store matches "${value}"`);
  throw new Error(
    `Store name is ambiguous: ${matches.map((store) => store.name).join(", ")}`,
  );
}

function printHelp() {
  console.log(`Usage:
  ${executable} stores [search]
  ${executable} deals <store> [--pages 1] [--json]
  ${executable} feed <store> [--pages all]
  ${executable} search <store> <product query> [--pages 1] [--json]
  ${executable} archive <store> [--pages all] [--file data/prices.jsonl]
  ${executable} archive --all-stores [--pages all] [--file data/prices.jsonl] [--delay-ms 1000]
  ${executable} track <store> <product query> [--file data/prices.jsonl]
  ${executable} sales [--file data/prices.jsonl] [--drop 20] [--samples 2]

Store can be a UUID or an unambiguous name such as "Royal Oak".
Use archive --all-stores to collect every ${retailerName} store (one specials
snapshot per store, ~1s delay between stores by default).`);
}

function summarize(observation) {
  return {
    productId: observation.product.id,
    product: observation.product.name,
    brand: observation.product.brand,
    priceCents: observation.price.promoCents ?? observation.price.regularCents,
    unitPrice:
      observation.price.comparative?.measureDescription ??
      observation.price.comparative?.display,
    promotion: observation.promotion,
    store: observation.store.name,
    observedAt: observation.observedAt,
  };
}

if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
} else if (command === "stores") {
  const stores = await client.listStores({ query: positional().join(" ") });
  for (const store of stores) {
    console.log(`${store.id}\t${store.name}\t${store.address}`);
  }
} else if (command === "sales") {
  const file = option("--file", "data/prices.jsonl");
  const archive = new PriceArchive(new JsonlObservationRepository(file));
  const feed = await archive.agentFeed({
    minDropPercent: Number(option("--drop", "0")),
    minSamples: Number(option("--samples", "2")),
    baselineDays: Number(option("--baseline-days", "90")),
  });
  console.log(JSON.stringify(feed, null, 2));
} else if (command === "archive" && hasFlag("--all-stores")) {
  const configuredPages = option("--pages", "all");
  const maxPages =
    configuredPages === "all" ? Number.POSITIVE_INFINITY : Number(configuredPages);
  if (!Number.isFinite(maxPages) && configuredPages !== "all") {
    throw new TypeError("--pages must be a number or all");
  }
  const delayMs = Number(option("--delay-ms", "1000"));
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new TypeError("--delay-ms must be a non-negative number");
  }
  const file = option("--file", "data/prices.jsonl");
  const archive = new PriceArchive(new JsonlObservationRepository(file));
  const stores = await client.listStores();
  if (stores.length === 0) {
    throw new Error(`No ${retailerName} stores returned by the store list API`);
  }

  const results = await archiveEachStore({
    stores,
    delayMs,
    collectForStore: (store) =>
      client.collectDeals({ storeId: store.id, store, maxPages }),
    record: (observations) =>
      archive.record(observations, { snapshotScope: "specials" }),
  });
  const summary = summarizeStoreResults(results);
  console.log(
    JSON.stringify(
      {
        retailer,
        mode: "all-stores",
        file,
        stores: summary.stores,
        succeeded: summary.succeeded,
        failed: summary.failed,
        fetched: summary.fetched,
        added: summary.added,
        results: summary.results,
      },
      null,
      2,
    ),
  );
  process.exitCode = exitCodeForStoreResults(summary);
} else if (
  command === "deals" ||
  command === "feed" ||
  command === "search" ||
  command === "archive" ||
  command === "track"
) {
  const values = positional();
  const store = await resolveStore(values[0]);
  const configuredPages = option(
    "--pages",
    ["archive", "feed"].includes(command) ? "all" : "1",
  );
  const maxPages = configuredPages === "all" ? Number.POSITIVE_INFINITY : Number(configuredPages);
  if (!Number.isFinite(maxPages) && configuredPages !== "all") {
    throw new TypeError("--pages must be a number or all");
  }

  const observations =
    ["search", "track"].includes(command)
      ? await client.collectProducts({
          storeId: store.id,
          store,
          maxPages,
          query: values.slice(1).join(" "),
        })
      : await client.collectDeals({ storeId: store.id, store, maxPages });

  if (command === "archive" || command === "track") {
    const file = option("--file", "data/prices.jsonl");
    const archive = new PriceArchive(new JsonlObservationRepository(file));
    const added = await archive.record(observations, {
      ...(command === "archive" ? { snapshotScope: "specials" } : {}),
    });
    console.log(
      JSON.stringify({ store: store.name, fetched: observations.length, added, file }, null, 2),
    );
  } else if (command === "feed") {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          currency: "NZD",
          store: { id: store.id, name: store.name, retailer },
          sales: observations.map(summarize),
        },
        null,
        2,
      ),
    );
  } else if (args.includes("--json")) {
    console.log(JSON.stringify(observations.map(summarize), null, 2));
  } else {
    for (const observation of observations) {
      const summary = summarize(observation);
      console.log(
        `${(summary.priceCents / 100).toFixed(2)}\t${summary.brand ?? ""}\t${summary.product}\t${summary.productId}`,
      );
    }
  }
} else {
  printHelp();
  process.exitCode = 1;
}
