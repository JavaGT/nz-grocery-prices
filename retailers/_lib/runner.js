/**
 * Generic collection CLI for the retailers/ campaign.
 *
 * Each retailer folder exposes a thin collect.js:
 *
 *   import { runCollect } from "../_lib/runner.js";
 *   import { RETAILER, createClient } from "./index.js";
 *   await runCollect({ RETAILER, createClient }, import.meta);
 *
 * The runner validates every observation with the canonical parseObservation
 * before writing JSONL, refuses to touch the live archive, and only writes
 * where an explicit --out points. Campaign collection never mutates
 * data/prices.jsonl implicitly.
 */

import { appendFile, writeFile } from "node:fs/promises";
import { parseObservation } from "../../src/domain/observation.js";
import { assertNotLiveArchive } from "../../scripts/lib/breadth-helpers.js";

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const key = token.slice(2);
    if (key === "stdout") {
      args.stdout = true;
      continue;
    }
    args[key] = argv[i + 1];
    i += 1;
  }
  return args;
}

function usage(slug) {
  return (
    `usage: node retailers/${slug}/collect.js (--out FILE | --stdout) ` +
    `[--max-pages N] [--page-size N] [--max-observations N] [--category HANDLE] [--query TERM] [--origin URL] [--force]`
  );
}

/**
 * Run the campaign collection flow for one retailer.
 *
 * ctx: { RETAILER: {slug, ...}, createClient: (options) => client }
 * The client must expose either collectProducts(options) (catalog families)
 * or searchProducts({query, ...}) plus listCategory({handle, ...}) — the
 * runner picks based on flags: --query -> searchProducts, --category ->
 * listCategory, otherwise collectProducts.
 *
 * Flags map onto client options: --max-pages bounds pagination, --page-size
 * bounds each request, --max-observations slices the result (runner-side,
 * after collection).
 */
export async function runCollect(ctx, importMeta) {
  const slug = ctx.RETAILER.slug;
  const args = parseArgs(process.argv.slice(2));
  if (!args.out && !args.stdout) {
    console.error(usage(slug));
    process.exitCode = 2;
    return;
  }

  const maxPages = args["max-pages"] ? Number(args["max-pages"]) : undefined;
  const pageSize = args["page-size"] ? Number(args["page-size"]) : undefined;
  const maxObservations = args["max-observations"] ? Number(args["max-observations"]) : undefined;
  const options = {
    ...(maxPages !== undefined ? { maxPages } : {}),
    ...(pageSize !== undefined ? { pageSize } : {}),
  };

  const client = ctx.createClient(
    args.origin === undefined ? {} : { origin: args.origin },
  );
  let observations;
  if (args.query) {
    observations = await client.searchProducts({ query: args.query, ...options });
  } else if (args.category) {
    observations = await client.listCategory(args.category, options);
  } else if (typeof client.collectProducts === "function") {
    observations = await client.collectProducts(options);
  } else {
    throw new TypeError(`${slug} client exposes neither collectProducts nor searchProducts`);
  }
  if (maxObservations !== undefined) observations = observations.slice(0, maxObservations);

  const valid = observations.map((observation) => parseObservation(observation));
  if (!args.stdout) {
    assertNotLiveArchive(args.out);
    if (args.force) {
      await writeFile(args.out, `${valid.map((o) => JSON.stringify(o)).join("\n")}\n`, "utf8");
    } else {
      await appendFile(args.out, `${valid.map((o) => JSON.stringify(o)).join("\n")}\n`, "utf8");
    }
    console.log(
      `${slug}: wrote ${valid.length} observations (${observations.length - valid.length} rejected) to ${args.out}`,
    );
  } else {
    for (const observation of valid) console.log(JSON.stringify(observation));
  }
  if (valid.length === 0) {
    console.error(`${slug}: collection produced zero valid observations`);
    process.exitCode = 1;
  }
  return valid;
}
