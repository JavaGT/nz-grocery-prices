#!/usr/bin/env node

import { PriceArchive } from "../src/archive.js";
import { WoolworthsClient } from "../src/adapters/woolworths.js";
import { JsonlObservationRepository } from "../src/repository.js";

const client = new WoolworthsClient({ cookie: process.env.WOOLWORTHS_COOKIE });
const [command = "help", ...args] = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function summarize(observation) {
  return {
    productId: observation.product.id,
    gtin: observation.product.gtin,
    product: observation.product.name,
    brand: observation.product.brand,
    priceCents:
      observation.price.promoCents ??
      observation.price.memberCents ??
      observation.price.regularCents,
    regularCents: observation.price.regularCents,
    unitPrice:
      observation.price.comparative?.measureDescription ??
      observation.price.comparative?.display,
    promotion: observation.promotion,
    store: observation.store,
    observedAt: observation.observedAt,
  };
}

function printHelp() {
  console.log(`Usage:
  woolworths store
  woolworths deals [--pages 1] [--size 100] [--json]
  woolworths feed [--pages all] [--size 100]
  woolworths archive [--pages all] [--size 100] [--file data/prices.jsonl]

The anonymous site defaults to its Glenfield fulfilment store. Set
WOOLWORTHS_COOKIE to reuse another location selected in your browser.`);
}

if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
} else if (command === "store") {
  console.log(JSON.stringify(await client.getStore(), null, 2));
} else if (["deals", "feed", "archive"].includes(command)) {
  const configuredPages = option("--pages", ["feed", "archive"].includes(command) ? "all" : "1");
  const maxPages = configuredPages === "all" ? Number.POSITIVE_INFINITY : Number(configuredPages);
  const size = Number(option("--size", "100"));
  if ((!Number.isFinite(maxPages) && configuredPages !== "all") || !Number.isFinite(size)) {
    throw new TypeError("--pages must be a number or all, and --size must be a number");
  }

  const observations = await client.collectDeals({ maxPages, size });
  if (command === "archive") {
    const file = option("--file", "data/prices.jsonl");
    const archive = new PriceArchive(new JsonlObservationRepository(file));
    const added = await archive.record(observations, {
      ...(command === "archive" ? { snapshotScope: "specials" } : {}),
    });
    console.log(
      JSON.stringify(
        {
          store: observations[0]?.store,
          fetched: observations.length,
          added,
          file,
        },
        null,
        2,
      ),
    );
  } else if (command === "feed") {
    console.log(
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          currency: "NZD",
          store: observations[0]?.store,
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
