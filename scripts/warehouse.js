#!/usr/bin/env node

import { PriceArchive } from "../src/archive.js";
import { WarehouseClient } from "../src/adapters/warehouse.js";
import { JsonlObservationRepository } from "../src/repository.js";

const [command = "help", ...args] = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function positional() {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index].startsWith("--")) {
      index += 1;
      continue;
    }
    values.push(args[index]);
  }
  return values;
}

const client = new WarehouseClient();

function summarize(observation) {
  return {
    productId: observation.product.id,
    gtin: observation.product.gtin,
    product: observation.product.name,
    brand: observation.product.brand,
    priceCents: observation.price.promoCents ?? observation.price.regularCents,
    regularCents: observation.price.regularCents,
    promotion: observation.promotion,
    store: observation.store,
    observedAt: observation.observedAt,
  };
}

function printHelp() {
  console.log(`Usage:
  warehouse store
  warehouse deals [--pages 1] [--size 32] [--json]
  warehouse search <product query> [--pages 1] [--size 32] [--json]
  warehouse feed [--pages all] [--size 32]
  warehouse archive [--pages all] [--size 32] [--file data/prices.jsonl]
  warehouse track <product query> [--file data/prices.jsonl]

The public catalogue is scoped as The Warehouse Online. Its North/South
selector controls availability and does not identify an individual store price.`);
}

if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
} else if (command === "store") {
  console.log(JSON.stringify(client.getStore(), null, 2));
} else if (["deals", "search", "feed", "archive", "track"].includes(command)) {
  const configuredPages = option("--pages", ["archive", "feed"].includes(command) ? "all" : "1");
  const maxPages = configuredPages === "all" ? Number.POSITIVE_INFINITY : Number(configuredPages);
  const size = Number(option("--size", "32"));
  if ((!Number.isFinite(maxPages) && configuredPages !== "all") || !Number.isFinite(size)) {
    throw new TypeError("--pages must be a number or all, and --size must be a number");
  }

  const observations = ["search", "track"].includes(command)
    ? await client.collectProducts({ query: positional().join(" "), maxPages, size })
    : await client.collectDeals({ maxPages, size });

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
      console.log(`${(summary.priceCents / 100).toFixed(2)}\t${summary.brand ?? ""}\t${summary.product}\t${summary.productId}`);
    }
  }
} else {
  printHelp();
  process.exitCode = 1;
}
