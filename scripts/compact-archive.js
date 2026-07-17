#!/usr/bin/env node

/**
 * Compact a legacy JSONL archive (rewrite without dead revisions).
 * SQLite archive.db is already change-only and has no compact step.
 */
import { createObservationRepository } from "../src/archive-factory.js";
import { JsonlObservationRepository } from "../src/repository.js";

const index = process.argv.indexOf("--file");
const file = index === -1 ? "data/prices.jsonl" : process.argv[index + 1];

if (/\.(db|sqlite|sqlite3)$/i.test(file)) {
  console.error(
    "compact-archive only applies to JSONL. SQLite archive.db is already change-only; no compact needed.",
  );
  process.exit(1);
}

const repository = createObservationRepository(file);
if (!(repository instanceof JsonlObservationRepository)) {
  console.error(`Unsupported archive type for compact: ${file}`);
  process.exit(1);
}
console.log(JSON.stringify(await repository.compact(), null, 2));
