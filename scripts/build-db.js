#!/usr/bin/env node
import { resolve } from 'node:path';
import { ProjectionRepository } from '../src/sqlite/projection-repository.js';

function usage() {
  console.error('Usage: node scripts/build-db.js [--file <jsonl-path>] [--output <db-path>] [--force]');
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  let jsonlPath = resolve('data/prices.jsonl');
  let dbPath = resolve('data/prices.db');
  let force = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--file':
        jsonlPath = resolve(args[++i]);
        break;
      case '--output':
        dbPath = resolve(args[++i]);
        break;
      case '--force':
        force = true;
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

  const repo = new ProjectionRepository(jsonlPath, dbPath);

  try {
    // Two-DB guard: rebuild() refuses app.db paths itself; this early check
    // gives the CLI a clean message before any work is done.
    if (resolve(dbPath).toLowerCase().endsWith('app.db') ||
        resolve(dbPath).toLowerCase() ===
          resolve(process.env.APP_DB || 'data/app.db').toLowerCase()) {
      console.error(
        `Refusing --output ${dbPath}: that is the application DB. ` +
          `The two-DB rule keeps app.db (user data) out of every rebuild path — ` +
          `projections belong in prices.db.`
      );
      process.exit(1);
    }
    const result = repo.rebuild({ jsonlPath, dbPath, force });
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.status === 'rebuilt' || result.status === 'skipped' ? 0 : 1);
  } catch (err) {
    console.error(`Build failed: ${err.message}`);
    if (err.code) console.error(`  code: ${err.code}`);
    process.exit(1);
  }
}

if (process.argv[1] && (process.argv[1] === import.meta.filename || process.argv[1].endsWith('build-db.js'))) {
  main();
}
