#!/usr/bin/env node

import { PriceArchive } from "../src/archive.js";
import { WoolworthsClient } from "../src/adapters/woolworths.js";
import { createObservationRepository } from "../src/archive-factory.js";
import {
  archiveEachStore,
  exitCodeForStoreResults,
  makeFreshnessSkip,
  summarizeStoreResults,
} from "./lib/store-archive-loop.js";

const client = new WoolworthsClient({ cookie: process.env.WOOLWORTHS_COOKIE });
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
  woolworths stores [search]
  woolworths store [--store Queenstown]
  woolworths deals [--pages 1] [--size 100] [--json] [--store Queenstown]
  woolworths feed [--pages all] [--size 100] [--store Queenstown]
  woolworths archive [--pages all] [--size 100] [--file data/archive.db] [--store Queenstown]
  woolworths archive --all-stores [--pages all] [--size 100] [--file data/archive.db] [--delay-ms 1000] [--max-age-hours 12]

Prices are fulfilment-store specific. Anonymous default is Glenfield (courier).
--store switches the session to that click-and-collect store first.
--all-stores walks every Woolworths pickup store (~180).
--max-age-hours skips stores observed more recently (0 = never skip).
WOOLWORTHS_COOKIE can still seed a browser session if needed.`);
}

async function maybeSelectStore() {
  const storeQuery = option("--store", process.env.WOOLWORTHS_STORE);
  if (!storeQuery) return null;
  const store = await client.resolveStore(storeQuery);
  const selected = await client.setPickupStore(store.pickupAddressId);
  return { requested: store, selected };
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
          store.address?.toLocaleLowerCase("en-NZ").includes(query) ||
          store.id.includes(query),
      )
    : stores;
  for (const store of filtered) {
    console.log(`${store.id}\t${store.name}\t${store.address ?? ""}`);
  }
} else if (command === "store") {
  await maybeSelectStore();
  console.log(JSON.stringify(await client.getStore(), null, 2));
} else if (command === "archive" && hasFlag("--all-stores")) {
  const configuredPages = option("--pages", "all");
  const maxPages =
    configuredPages === "all" ? Number.POSITIVE_INFINITY : Number(configuredPages);
  const size = Number(option("--size", "100"));
  if ((!Number.isFinite(maxPages) && configuredPages !== "all") || !Number.isFinite(size)) {
    throw new TypeError("--pages must be a number or all, and --size must be a number");
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
    throw new Error("No Woolworths pickup stores returned");
  }

  // One sticky session: switch pickup store, then collect specials for that store.
  const results = await archiveEachStore({
    stores,
    delayMs,
    shouldSkip: makeFreshnessSkip({
      repository,
      retailer: "woolworths",
      maxAgeMs: maxAgeHours * 3_600_000,
    }),
    collectForStore: async (store) => {
      await client.setPickupStore(store.pickupAddressId);
      return client.collectDeals({ maxPages, size });
    },
    record: (observations) =>
      archive.record(observations, { snapshotScope: "specials" }),
  });
  const summary = summarizeStoreResults(results);
  console.log(
    JSON.stringify(
      {
        retailer: "woolworths",
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
} else if (["deals", "feed", "archive"].includes(command)) {
  const configuredPages = option("--pages", ["feed", "archive"].includes(command) ? "all" : "1");
  const maxPages = configuredPages === "all" ? Number.POSITIVE_INFINITY : Number(configuredPages);
  const size = Number(option("--size", "100"));
  if ((!Number.isFinite(maxPages) && configuredPages !== "all") || !Number.isFinite(size)) {
    throw new TypeError("--pages must be a number or all, and --size must be a number");
  }

  const selected = await maybeSelectStore();
  const observations = await client.collectDeals({ maxPages, size });
  if (command === "archive") {
    const file = option("--file", "data/archive.db");
    const archive = new PriceArchive(createObservationRepository(file));
    const added = await archive.record(observations, {
      snapshotScope: "specials",
    });
    console.log(
      JSON.stringify(
        {
          store: observations[0]?.store ?? selected?.selected,
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
          store: observations[0]?.store ?? selected?.selected,
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
