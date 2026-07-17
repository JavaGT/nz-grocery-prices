#!/usr/bin/env node

import { PriceArchive } from "../src/archive.js";
import { FreshChoiceClient } from "../src/adapters/freshchoice.js";
import { createObservationRepository } from "../src/archive-factory.js";
import {
  archiveEachStore,
  exitCodeForStoreResults,
  makeFreshnessSkip,
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

const client = new FreshChoiceClient({
  origin: option("--origin", process.env.FRESHCHOICE_ORIGIN),
  storeName: process.env.FRESHCHOICE_STORE_NAME,
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
  freshchoice stores [search]
  freshchoice store [--origin https://queenstown.store.freshchoice.co.nz]
  freshchoice deals [--pages 1] [--json] [--origin URL]
  freshchoice search <product query> [--pages 1] [--json] [--origin URL]
  freshchoice feed [--pages all] [--origin URL]
  freshchoice archive [--pages all] [--file data/archive.db] [--origin URL]
  freshchoice archive --all-stores [--pages all] [--file data/archive.db] [--delay-ms 1000] [--max-age-hours 12]
  freshchoice track <product query> [--file data/archive.db] [--origin URL]

Default origin is Queenstown. FRESHCHOICE_ORIGIN selects another storefront.
Use archive --all-stores to collect every FreshChoice storefront (~76).
--max-age-hours skips stores observed more recently (0 = never skip).`);
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
  const maxAgeHours = Number(option("--max-age-hours", "12"));
  if (!Number.isFinite(maxAgeHours) || maxAgeHours < 0) {
    throw new TypeError("--max-age-hours must be a non-negative number");
  }
  const file = option("--file", "data/archive.db");
  const repository = createObservationRepository(file);
  const archive = new PriceArchive(repository);
  const stores = await client.listStores();
  if (stores.length === 0) {
    throw new Error("No FreshChoice stores returned by the store list page");
  }

  const results = await archiveEachStore({
    stores,
    delayMs,
    shouldSkip: makeFreshnessSkip({
      repository,
      retailer: "freshchoice",
      maxAgeMs: maxAgeHours * 3_600_000,
    }),
    collectForStore: (store) =>
      new FreshChoiceClient({
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
        retailer: "freshchoice",
        mode: "all-stores",
        file,
        maxAgeHours,
        stores: summary.stores,
        succeeded: summary.succeeded,
        skipped: summary.skipped,
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
    const file = option("--file", "data/archive.db");
    const archive = new PriceArchive(createObservationRepository(file));
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
