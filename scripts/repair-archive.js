#!/usr/bin/env node
/**
 * Repair a JSONL grocery archive (CORE-2 M5).
 *
 * Holds the same `<archive>.lock` as every other archive writer while it
 * runs, then performs a tolerant scan (identical semantics to
 * JsonlObservationRepository's loader — shared via static helpers):
 *   1. bad fragments quarantined to <file>.corrupt-<ISO timestamp>
 *      (quarantine fsync'd BEFORE the clean file is rewritten);
 *   2. the surviving records atomically rewrite the archive via sibling
 *      temp → fh.sync() → rename → parent-dir fsync.
 *
 * The scan happens INSIDE the lock so no append/publish can interleave
 * between scan and rewrite.
 *
 * Never touches *.db files — those are the SQLite projection/app DBs, and
 * per the two-DB rule this tool must not open them.
 *
 * Output: JSON report { scanned, kept, recovered, quarantined, defects }.
 *
 * Usage:
 *   node scripts/repair-archive.js --file <archive.jsonl> [--force]
 */

import { open, realpath, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  JsonlObservationRepository,
  withArchiveLock,
  writeAllAndSync,
} from "../src/repository.js";

function parseArgs(argv) {
  const args = { force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--file") {
      index += 1;
      args.file = argv[index];
    } else if (value.startsWith("--file=")) {
      args.file = value.slice("--file=".length);
    } else if (value === "--force") {
      args.force = true;
    } else if (value === "--help" || value === "-h") {
      args.help = true;
    } else if (!value.startsWith("--")) {
      // Bare positional arguments are never valid for this CLI — accepting
      // them silently would let typos target the wrong path.
      (args.positionals ??= []).push(value);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));

if (!args.help && args.positionals?.length) {
  console.error(
    `Unexpected argument(s): ${args.positionals.join(", ")}. ` +
      `Pass the archive via --file <path> or --file=<path>.`,
  );
  process.exit(1);
}

if (args.help || !args.file) {
  console.log("Usage: node scripts/repair-archive.js (--file <archive.jsonl> | --file=<archive.jsonl>) [--force]");
  if (!args.help) console.error("--file <path> is required");
  process.exit(args.help ? 0 : 1);
}

const filePath = resolve(args.file);

if (/\.db$/i.test(filePath)) {
  console.error(
    `Refusing to repair ${filePath}: this is a SQLite DB, not a JSONL archive. ` +
      `The two-DB rule keeps prices.db (projection) and app.db (user data) out of ` +
      `the repair path entirely — archives are .jsonl.`,
  );
  process.exit(1);
}

if (!args.force) {
  // realpath both sides: macOS /tmp is a symlink to /private/tmp, so a
  // lexical comparison of "the same" path can differ by prefix.
  const [realFile, liveArchive] = await Promise.all([
    realpath(filePath).catch(() => filePath),
    realpath(resolve(process.env.ARCHIVE_FILE ?? "data/prices.jsonl"))
      .catch(() => resolve(process.env.ARCHIVE_FILE ?? "data/prices.jsonl")),
  ]);
  if (realFile === liveArchive) {
    console.error(
      `Refusing to repair the live archive (${filePath}) without --force. ` +
        `Repair rewrites the file in place; pass --force once you have a copy/backup.`,
    );
    process.exit(1);
  }
}

// ---- tolerant scan + rewrite, ALL under the archive lock ----
//
// The scan must happen inside the lock: anything read before acquiring it
// can be stale (an append can land between scan and rewrite), so the
// whole sequence is wrapped in withArchiveLock().

const report = { scanned: 0, kept: 0, recovered: 0, quarantined: 0, defects: [] };
const keptRecords = [];
const quarantined = [];

async function fsyncFile(path, payload) {
  const handle = await open(path, "w");
  try {
    // writeAllAndSync loops on short writes before fsyncing — a partial
    // write here would otherwise quarantine/rewrite truncated content.
    await writeAllAndSync(handle, payload);
  } finally {
    await handle.close();
  }
}

try {
  await withArchiveLock(filePath, async () => {
    // Re-scan INSIDE the lock.
    let lines;
    try {
      lines = await JsonlObservationRepository.readArchiveLines(filePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error(`No such file: ${filePath}`);
      }
      throw error;
    }

    for (const [index, entry] of lines.entries()) {
      const lineNumber = index + 1;
      if (entry.line.trim() === "") continue; // stray blank lines are not corruption

      let outcome;
      try {
        outcome = JsonlObservationRepository.decodeArchiveLine(
          entry.line,
          filePath,
          lineNumber,
          entry.terminated,
        );
      } catch (error) {
        // decodeArchiveLine only throws for TERMINATED bad lines — in a repair
        // context those are quarantined rather than fatal, so the rest of the
        // archive survives.
        quarantined.push({ line: lineNumber, fragment: entry.line, reason: String(error.message) });
        report.quarantined += 1;
        continue;
      }

      if (outcome.status === "torn") {
        quarantined.push({
          line: lineNumber,
          fragment: entry.line,
          reason: "unterminated final bytes that do not decode to a record",
        });
        report.quarantined += 1;
        continue;
      }

      if (outcome.status === "legacy") {
        // Legacy v1 whole-observations are kept byte-for-byte; migration to v2
        // is CORE-6's job, not repair's.
        keptRecords.push(entry.line);
        report.kept += 1;
        continue;
      }

      // Valid v2 record. A repaired hash is written back so future loads are
      // defect-free; the pre-repair value is preserved in the report.
      if (outcome.defect) {
        outcome.record.hash = outcome.defect.recomputed;
        report.defects.push(outcome.defect);
      }
      keptRecords.push(JSON.stringify(outcome.record));
      report.kept += 1;
      if (!entry.terminated) report.recovered += 1;
    }
    report.scanned = lines.length;

    // ---- quarantine first, then atomic rewrite ----

    if (quarantined.length > 0) {
      const quarantinePath = `${filePath}.corrupt-${new Date().toISOString().replaceAll(":", "-")}`;
      await fsyncFile(
        quarantinePath,
        quarantined
          .map((entry) => JSON.stringify(entry))
          .join("\n") + "\n",
      );
      report.quarantineFile = quarantinePath;
      // Fsync the parent directory NOW, before the live-file rename below:
      // a crash in between must not lose the quarantine entry AND the old
      // file together (the corrupt bytes would be gone with no copy left).
      const quarantineDirHandle = await open(dirname(filePath), "r");
      try {
        await quarantineDirHandle.sync();
      } finally {
        await quarantineDirHandle.close();
      }
    }

    const tempPath = `${filePath}.repair-${process.pid}-${Date.now()}.tmp`;
    try {
      await fsyncFile(tempPath, keptRecords.join("\n") + (keptRecords.length ? "\n" : ""));
      await rename(tempPath, filePath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }

    // fsync the parent directory so the live-file rename survives a crash
    // (the quarantine entry was already made durable above).
    const dirHandle = await open(dirname(filePath), "r");
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
  });
} catch (error) {
  console.error(`repair failed before rewrite completed: ${error.message}`);
  process.exit(1);
}

console.log(JSON.stringify(report, null, 2));
