#!/usr/bin/env node
/**
 * Stream data/prices.jsonl into data/archive.db (normalized authoritative archive).
 * Does not load the whole JSONL into one string. Never opens app.db.
 */
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { SqliteArchiveRepository } from '../src/sqlite/archive-repository.js';

function usage() {
  console.error('Usage: node scripts/migrate-jsonl-to-archive.js [--file <jsonl>] [--output <archive.db>] [--strict]');
  process.exit(1);
}

async function main() {
  const args = process.argv.slice(2);
  let jsonlPath = resolve('data/prices.jsonl');
  let dbPath = resolve('data/archive.db');
  let strict = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--file':
        jsonlPath = resolve(args[++i]);
        break;
      case '--output':
        dbPath = resolve(args[++i]);
        break;
      case '--strict':
        strict = true;
        break;
      case '--help':
      case '-h':
        usage();
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        usage();
    }
  }

  if (!existsSync(jsonlPath)) {
    console.error(`JSONL not found: ${jsonlPath}`);
    process.exit(1);
  }

  const repo = new SqliteArchiveRepository(dbPath);
  try {
    console.error(`Importing ${jsonlPath} → ${dbPath}`);
    const result = await repo.importJsonl(jsonlPath, { strict });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    repo.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
