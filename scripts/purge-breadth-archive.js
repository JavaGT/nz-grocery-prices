#!/usr/bin/env node
/**
 * BREADTH-15 — one-time purge of stray-retailer records from a breadth
 * pilot archive. data/breadth-pilot.jsonl (the paknsave archive) carries
 * newworld records from the era when both banners shared one file; they
 * inflate paknsave report stats.
 *
 * Safety (mirrors scripts/migrate-v1-archive.js): backup-first, atomic
 * tmp+rename rewrite, refuses the live archive and refuses to run without
 * an explicit --retailer. A record belongs to the stray retailer when its
 * productId, storeId, or offerId starts with "<retailer>:".
 *
 * Usage:
 *   node scripts/purge-breadth-archive.js --file data/breadth-pilot.jsonl \
 *     --retailer newworld
 */

import { copyFile, open, rename, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const LIVE_ARCHIVE_FALLBACK = "data/prices.jsonl";

function parseArgs(argv) {
  const options = { file: null, retailer: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      index += 1;
      if (index >= argv.length) throw new TypeError(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === "--file") options.file = value();
    else if (arg === "--retailer") options.retailer = value();
    else throw new TypeError(`Unknown argument: ${arg}`);
  }
  if (!options.file || !options.retailer) {
    throw new TypeError("--file and --retailer are required");
  }
  if (!["paknsave", "newworld", "freshchoice", "warehouse", "woolworths"].includes(options.retailer)) {
    throw new TypeError(`--retailer must be a known retailer, got: ${options.retailer}`);
  }
  return options;
}

function belongsToRetailer(record, retailer) {
  const prefix = `${retailer}:`;
  return (
    record.productId?.startsWith(prefix) ||
    record.storeId?.startsWith(prefix) ||
    record.offerId?.startsWith(prefix)
  );
}

async function* jsonlLines(filePath) {
  const handle = await open(filePath, "r");
  try {
    const stream = handle.createReadStream({ encoding: "utf8" });
    let pending = "";
    for await (const chunk of stream) {
      const pieces = chunk.split("\n");
      pending += pieces[0];
      for (let index = 1; index < pieces.length; index += 1) {
        yield pending;
        pending = pieces[index];
      }
    }
    if (pending !== "") yield pending;
  } finally {
    await handle.close();
  }
}

export async function purgeArchive(file, retailer) {
  const target = resolve(file);
  const live = resolve(process.env.ARCHIVE_FILE ?? LIVE_ARCHIVE_FALLBACK);
  if (target === live) {
    throw new Error(
      `Refusing to purge ${file}: that resolves to the live archive.`,
    );
  }
  await stat(target); // throws if missing

  const backupPath = `${target}.pre-${retailer}-purge`;
  await copyFile(target, backupPath);

  const tmpPath = `${target}.purge-tmp`;
  const handle = await open(tmpPath, "w");
  let kept = 0;
  let purged = 0;
  let invalidLines = 0;
  try {
    for await (const line of jsonlLines(target)) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        invalidLines += 1;
        continue;
      }
      if (belongsToRetailer(record, retailer)) {
        purged += 1;
        continue;
      }
      await handle.write(line + "\n");
      kept += 1;
    }
  } catch (error) {
    await handle.close();
    await rename(backupPath, target).catch(() => {});
    throw error;
  }
  await handle.sync();
  await handle.close();
  await rename(tmpPath, target);

  return { backupPath, kept, purged, invalidLines };
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const { file, retailer } = parseArgs(process.argv.slice(2));
    const result = await purgeArchive(file, retailer);
    console.log(
      JSON.stringify({
        file,
        retailer,
        kept: result.kept,
        purged: result.purged,
        invalidLines: result.invalidLines,
        backup: result.backupPath,
      }),
    );
  } catch (error) {
    console.error(`error: ${error.message}`);
    process.exitCode = 1;
  }
}
