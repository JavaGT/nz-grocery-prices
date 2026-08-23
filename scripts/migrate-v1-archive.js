#!/usr/bin/env node
/**
 * One-shot v1 → v2 archive migrator (CORE-6).
 *
 * Legacy v1 lines are whole observations (product + store + price + source,
 * no version field). This tool converts each one into the change-only v2
 * record set (product/store/offer revisions) it would have produced at
 * ingest, deriving additions against ALL PRECEDING state so a v1 line never
 * silently duplicates or drops a fact. Valid v2 lines pass through untouched
 * and in order; mixed archives keep their relative line order.
 *
 * Safety model (mirrors scripts/repair-archive.js):
 *   - requires an explicit --file (rejects *.db per the two-DB rule);
 *   - refuses the live data/prices.jsonl without --force;
 *   - scans INSIDE the shared <archive>.lock so no writer interleaves;
 *   - quarantines undecodable lines to <file>.corrupt-<timestamp> (fsync'd
 *     BEFORE the rewrite) instead of inventing data for them;
 *   - backs up the original to <file>.pre-v2-migration-<timestamp>
 *     (fsync'd BEFORE the replace), then rewrites via sibling temp file +
 *     writeAllAndSync + rename + parent-dir fsync.
 *
 * --dry-run reports {v1, v2, invalid, changes} and touches nothing. A run
 * with no v1 lines is a no-op: no backup, no rewrite — second runs are safe.
 *
 * Usage:
 *   node scripts/migrate-v1-archive.js (--file <archive.jsonl> |
 *        --file=<archive.jsonl>) [--dry-run] [--force]
 */

import { open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  JsonlObservationRepository,
  withArchiveLock,
  writeAllAndSync,
} from "../src/repository.js";
import {
  classifyParsedRecord,
  encodeRecord,
  isV1Record,
} from "../src/archive-records.js";
import { ArchiveIndex } from "../src/archive-index.js";
import { parseObservation } from "../src/domain/observation.js";

function parseArgs(argv) {
  const args = { force: false, dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--file") {
      index += 1;
      args.file = argv[index];
    } else if (value.startsWith("--file=")) {
      args.file = value.slice("--file=".length);
    } else if (value === "--force") {
      args.force = true;
    } else if (value === "--dry-run") {
      args.dryRun = true;
    } else if (value === "--help" || value === "-h") {
      args.help = true;
    } else if (!value.startsWith("--")) {
      // Bare positional arguments are never valid — accepting them silently
      // would let typos target the wrong path.
      (args.positionals ??= []).push(value);
    }
  }
  return args;
}

/** fsync `payload` to `path` (looping over short writes) and close. */
async function fsyncFile(path, payload) {
  const handle = await open(path, "w");
  try {
    await writeAllAndSync(handle, payload);
  } finally {
    await handle.close();
  }
}

/** fsync the parent directory of `path` so a rename/create survives a crash. */
async function fsyncParentDir(path) {
  const handle = await open(dirname(path), "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Convert one v1 observation into its v2 record additions against `index`
 * (which must already reflect every preceding archive line). Uses the same
 * planning path as normal appends, so temporal-anchor dedup semantics apply:
 * only genuinely new product/store/offer revisions are emitted.
 */
function planV1Additions(index, record) {
  // Validate as an observation FIRST — a malformed v1 line is quarantined
  // with actionable problems rather than half-projected into the archive.
  parseObservation(record);
  return index.planAppend([record]);
}

// ---- CLI guard rails (before any file access) ----

const args = parseArgs(process.argv.slice(2));

if (!args.help && args.positionals?.length) {
  console.error(
    `Unexpected argument(s): ${args.positionals.join(", ")}. ` +
      `Pass the archive via --file <path> or --file=<path>.`,
  );
  process.exit(1);
}

if (args.help || !args.file) {
  console.log(
    "Usage: node scripts/migrate-v1-archive.js " +
      "(--file <archive.jsonl> | --file=<archive.jsonl>) [--dry-run] [--force]",
  );
  if (!args.help) console.error("--file <path> is required");
  process.exit(args.help ? 0 : 1);
}

const filePath = resolve(args.file);

if (/\.db$/i.test(filePath)) {
  console.error(
    `Refusing to migrate ${filePath}: this is a SQLite DB, not a JSONL archive. ` +
      `The two-DB rule keeps prices.db (projection) and app.db (user data) out of ` +
      `the migration path entirely — archives are .jsonl.`,
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
      `Refusing to migrate the live archive (${filePath}) without --force. ` +
        `Migration rewrites the file in place; run --dry-run against a copy first.`,
    );
    process.exit(1);
  }
}

// ---- scan + conditional atomic rewrite, ALL under the archive lock ----

const report = { v1: 0, v2: 0, invalid: 0, changes: 0 };

try {
  await withArchiveLock(filePath, async () => {
    // Re-scan INSIDE the lock: anything read before acquiring it can be
    // stale by the time the lock is held.
    let lines;
    try {
      lines = await JsonlObservationRepository.readArchiveLines(filePath);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`No such file: ${filePath}`);
      throw error;
    }

    // Index replaying ALL preceding state; v1 additions derive against it.
    const index = new ArchiveIndex();
    const outputLines = [];
    const quarantined = [];
    const invalidDetails = [];

    for (const [position, entry] of lines.entries()) {
      const lineNumber = position + 1;
      if (entry.line.trim() === "") continue; // blank lines carry no facts

      let parsed;
      try {
        parsed = JSON.parse(entry.line);
      } catch {
        report.invalid += 1;
        invalidDetails.push(`line ${lineNumber}: not valid JSON`);
        quarantined.push({
          line: lineNumber,
          fragment: entry.line,
          reason: "not valid JSON",
        });
        continue;
      }

      const verdict = classifyParsedRecord(parsed);

      if (verdict.status === "invalid") {
        report.invalid += 1;
        invalidDetails.push(`line ${lineNumber}: ${verdict.problems.join("; ")}`);
        quarantined.push({
          line: lineNumber,
          fragment: entry.line,
          reason: verdict.problems.join("; "),
        });
        continue;
      }

      if (verdict.status !== "legacy") {
        // Valid v2: preserved byte-for-byte in position.
        index.apply(parsed);
        outputLines.push({ kind: "raw", line: entry.line });
        report.v2 += 1;
        continue;
      }

      // Legacy v1 whole-observation → project to v2 additions.
      let additions;
      try {
        additions = planV1Additions(index, verdict.record);
      } catch (error) {
        // A v1-SHAPED line that fails observation validation is invalid,
        // not migrated — it counts only in `invalid` and is quarantined.
        report.invalid += 1;
        invalidDetails.push(`line ${lineNumber} (v1): ${error.message}`);
        quarantined.push({
          line: lineNumber,
          fragment: entry.line,
          reason: `v1 observation invalid: ${error.message}`,
        });
        continue;
      }
      report.v1 += 1;

      // Preserve mixed line order: derived records take the v1 line's slot.
      outputLines.push({
        kind: "derived",
        records: additions.map((record) => encodeRecord(record)),
      });
      report.changes += additions.length;
      for (const record of additions) index.apply(record);
    }

    if (report.invalid > 0) {
      console.error(
        `Found ${report.invalid} undecodable/malformed line(s); they will be ` +
          `quarantined, NOT invented around:\n  ${invalidDetails.join("\n  ")}`,
      );
    }

    if (args.dryRun || report.v1 === 0) {
      // Dry run, or nothing to migrate: report and leave the file untouched.
      // (A no-v1 run writes NO backup and performs NO rewrite — this is what
      // makes a second migration run a true no-op.)
      report.dryRun = args.dryRun;
      return;
    }

    // ---- apply mode: backup → quarantine → temp+rename rewrite ----

    // Backup the ORIGINAL BYTES read at scan time (not a re-serialization of
    // parsed lines), so blank lines, ordering, and the exact final newline
    // state are preserved byte-for-byte.
    const originalBytes = await readFile(filePath);
    const backupPath =
      `${filePath}.pre-v2-migration-${new Date().toISOString().replaceAll(":", "-")}`;
    await fsyncFile(backupPath, originalBytes);
    report.backupFile = backupPath;
    // Durable BEFORE the live-file rename below: a crash in between must
    // not lose both the backup and the migrated file together.
    await fsyncParentDir(backupPath);

    if (quarantined.length > 0) {
      const quarantinePath =
        `${filePath}.corrupt-${new Date().toISOString().replaceAll(":", "-")}`;
      await fsyncFile(
        quarantinePath,
        quarantined.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
      report.quarantineFile = quarantinePath;
      await fsyncParentDir(quarantinePath);
    }

    const content = outputLines
      .map((entry) =>
        entry.kind === "raw" ? entry.line : entry.records.join("\n"),
      )
      .filter((block) => block.length > 0)
      .join("\n") + "\n";

    const tempPath = `${filePath}.migrate-${process.pid}-${Date.now()}.tmp`;
    try {
      await fsyncFile(tempPath, content);
      await rename(tempPath, filePath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
    await fsyncParentDir(filePath);
  });
} catch (error) {
  console.error(`migration failed before rewrite completed: ${error.message}`);
  process.exit(1);
}

console.log(JSON.stringify(report, null, 2));
