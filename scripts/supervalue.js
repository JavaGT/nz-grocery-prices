#!/usr/bin/env node

import { PriceArchive } from "../src/archive.js";
import { SuperValueClient } from "../src/adapters/supervalue.js";
import { JsonlObservationRepository } from "../src/repository.js";
import {
  archiveEachStore,
  exitCodeForStoreResults,
  summarizeStoreResults,
} from "./lib/store-archive-loop.js";

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
      if (args[index + 1] === undefined || args[index + 1].startsWith("--")) continue;
      index += 1;
      continue;
    }
    values.push(args[index]);
  }
  return values;
}

const client = new SuperValueClient({
  origin: option("--origin", process.env.SUPERVALUE_ORIGIN),
  storeName: process.env.SUPERVALUE_STORE_NAME,
});

function summarize(observation) {
  return {
    productId: observation.product.id,
    product: observation.product.name,
    priceCents: observation.price.promoCents ?? observation.price.regularCents,
    regularCents: observation.price.regularCents,
    unitPrice: observation.price.comparative?.display,
    promotion: observation.promotion,
    store: observation.store,
    observedAt: observation.observedAt,
  };
}

function printHelp() {
  console.log(`Usage:
  supervalue stores [search]
  supervalue store [--origin https://milton.store.supervalue.co.nz]
  supervalue deals [--pages 1] [--json] [--origin URL]
  supervalue search <product query> [--pages 1] [--json] [--origin URL]
  supervalue feed [--pages all] [--origin URL]
  supervalue archive [--pages all] [--file data/prices.jsonl] [--origin URL]
  supervalue archive --all-stores [--pages all] [--file data/prices.jsonl] [--delay-ms 1000]
  supervalue track <product query> [--file data/prices.jsonl] [--origin URL]

Default origin is Milton. SUPERVALUE_ORIGIN selects another storefront.
Only a few SuperValue stores run webshops (~3); archive --all-stores
collects every one of them.`);
}

if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
} else if (command === "stores") {
  const query = positional().join(" ").toLocaleLowerCase("en-NZ");
  const stores = await client.listStores();
  const filtered = query
    ? stores.filter(
        (store) =>
          store.name.toLocaleLowerCase("en-NZ").includes(query) ||
          store.slug.includes(query) ||
          store.address?.toLocaleLowerCase("en-NZ").includes(query),
      )
    : stores;
  for (const store of filtered) {
    console.log(`${store.slug}\t${store.name}\t${store.origin}\t${store.address ?? ""}`);
  }
} else if (command === "store") {
  console.log(JSON.stringify(client.getStore(), null, 2));
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
    throw new Error("No SuperValue webshops returned by the store chooser");
  }

  const results = await archiveEachStore({
    stores,
    delayMs,
    collectForStore: (store) =>
      new SuperValueClient({
        origin: store.origin,
        storeName: store.name,
        storeAddress: store.address,
        storeSlug: store.slug,
      }).collectDeals({ maxPages }),
    record: (observations) =>
      archive.record(observations, { snapshotScope: "specials" }),
  });
  const summary = summarizeStoreResults(results);
  console.log(
    JSON.stringify(
      {
        retailer: "supervalue",
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
} else if (["deals", "search", "feed", "archive", "track"].includes(command)) {
  const configuredPages = option("--pages", ["archive", "feed"].includes(command) ? "all" : "1");
  const maxPages = configuredPages === "all" ? Number.POSITIVE_INFINITY : Number(configuredPages);
  if (!Number.isFinite(maxPages) && configuredPages !== "all") {
    throw new TypeError("--pages must be a number or all");
  }

  const observations = ["search", "track"].includes(command)
    ? await client.collectProducts({ query: positional().join(" "), maxPages })
    : await client.collectDeals({ maxPages });

  if (["archive", "track"].includes(command)) {
    const file = option("--file", "data/prices.jsonl");
    const archive = new PriceArchive(new JsonlObservationRepository(file));
    const added = await archive.record(observations, {
      ...(command === "archive" ? { snapshotScope: "specials" } : {}),
    });
    console.log(JSON.stringify({ store: client.getStore(), fetched: observations.length, added, file }, null, 2));
  } else if (command === "feed") {
    console.log(JSON.stringify({
      generatedAt: new Date().toISOString(),
      currency: "NZD",
      store: client.getStore(),
      sales: observations.map(summarize),
    }, null, 2));
  } else if (args.includes("--json")) {
    console.log(JSON.stringify(observations.map(summarize), null, 2));
  } else {
    for (const observation of observations) {
      const summary = summarize(observation);
      console.log(`${(summary.priceCents / 100).toFixed(2)}\t${summary.product}\t${summary.productId}`);
    }
  }
} else {
  printHelp();
  process.exitCode = 1;
}
