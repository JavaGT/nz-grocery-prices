#!/usr/bin/env node
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ProjectionRepository } from '../src/sqlite/projection-repository.js';
import { AppDatabase } from '../src/sqlite/app-db.js';
import { MatchingOrchestrator } from '../src/matching/orchestrator.js';

function usage() {
  console.error('Usage: node scripts/matching-cli.js [--prices-db <path>] [--app-db <path>] [--fuzzy] [--help]');
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  let pricesDbPath = resolve('data/prices.db');
  let appDbPath = resolve('data/app.db');
  let runFuzzy = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--prices-db':
        pricesDbPath = resolve(args[++i]);
        break;
      case '--app-db':
        appDbPath = resolve(args[++i]);
        break;
      case '--fuzzy':
        runFuzzy = true;
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

  let projDb;
  let appDb;

  try {
    const repo = new ProjectionRepository(null, pricesDbPath);
    repo.open();
    projDb = repo;
  } catch (err) {
    console.error(`Failed to open projection DB: ${err.message}`);
    process.exit(1);
  }

  try {
    appDb = new AppDatabase(appDbPath);
  } catch (err) {
    console.error(`Failed to open app DB: ${err.message}`);
    projDb.close();
    process.exit(1);
  }

  const products = projDb.db.prepare(
    'SELECT id, retailer_id, name, brand, category, size, source_id, gtin FROM products'
  ).all();

  console.error(`Loaded ${products.length} products from projection DB`);

  const orchestrator = new MatchingOrchestrator(appDb, products);

  const autoResult = orchestrator.runAutoMatches();
  console.log(JSON.stringify({ auto: autoResult }, null, 2));

  if (runFuzzy) {
    const fuzzyResult = orchestrator.runFuzzyCandidates();
    console.log(JSON.stringify({ fuzzy: fuzzyResult }, null, 2));
  }

  projDb.close();
  appDb.close();
}

if (process.argv[1] && (process.argv[1] === import.meta.filename || process.argv[1].endsWith('matching-cli.js'))) {
  main();
}
