#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { PriceArchive } from "../src/archive.js";
import { JsonlObservationRepository } from "../src/repository.js";

const [command = "help", ...args] = process.argv.slice(2);

function option(name, fallback) {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function options(name) {
  return args.flatMap((value, index) => value === name ? [args[index + 1]] : []).filter(Boolean);
}

async function productIds() {
  const ids = options("--product");
  const favoritesFile = option("--favorites");
  if (!favoritesFile) return ids.length ? ids : undefined;
  const value = JSON.parse(await readFile(favoritesFile, "utf8"));
  const favorites = Array.isArray(value) ? value : value.productIds;
  if (!Array.isArray(favorites)) {
    throw new TypeError("Favorites must be a JSON array or an object with productIds");
  }
  return [...new Set([...ids, ...favorites])];
}

function printHelp() {
  console.log(`Usage:
  grocery-prices feed [--drop 20] [--samples 2] [--baseline-days 90]
                       [--fresh-days 7] [--product PRODUCT_ID]
                       [--favorites favorites.json] [--retailer RETAILER]
  grocery-prices ongoing [the same filters]
  grocery-prices history <product-id> [--store STORE_ID]
  grocery-prices product <product-id>
  grocery-prices stats [--retailer RETAILER]

All commands read data/prices.jsonl unless --file specifies another archive.
feed returns both current advertised promotions and history-backed price drops
or all-time lows. product returns content-addressed product revisions, such as
a changed title, image, size, or description. Repeat --product to restrict
feed output to favourites.`);
}

const file = option("--file", "data/prices.jsonl");
const archive = new PriceArchive(new JsonlObservationRepository(file));

if (command === "help" || command === "--help" || command === "-h") {
  printHelp();
} else if (["feed", "ongoing"].includes(command)) {
  const query = {
    minDropPercent: Number(option("--drop", "20")),
    minSamples: Number(option("--samples", "2")),
    baselineDays: Number(option("--baseline-days", "90")),
    freshWithinDays: Number(option("--fresh-days", "7")),
    includeAllTimeLows: true,
    productIds: await productIds(),
    retailer: option("--retailer"),
    storeId: option("--store"),
    pricePolicy: args.includes("--member-prices") ? "member" : "public",
  };
  const result = command === "ongoing"
    ? await archive.ongoingSales(query)
    : await archive.agentFeed(query);
  console.log(JSON.stringify(result, null, 2));
} else if (command === "history") {
  const productId = args[0];
  if (!productId || productId.startsWith("--")) throw new Error("Provide a product ID");
  console.log(JSON.stringify(await archive.history({
    productId,
    storeId: option("--store"),
  }), null, 2));
} else if (command === "product") {
  const productId = args[0];
  if (!productId || productId.startsWith("--")) throw new Error("Provide a product ID");
  console.log(JSON.stringify(await archive.productHistory(productId), null, 2));
} else if (command === "stats") {
  const observations = await archive.history({ retailer: option("--retailer") });
  const stores = new Map();
  const products = new Set();
  for (const observation of observations) {
    stores.set(observation.store.id, observation.store);
    products.add(observation.product.id);
  }
  console.log(JSON.stringify({
    file,
    observations: observations.length,
    products: products.size,
    stores: [...stores.values()],
  }, null, 2));
} else {
  printHelp();
  process.exitCode = 1;
}
