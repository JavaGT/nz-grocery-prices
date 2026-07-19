#!/usr/bin/env node
// Rebuild the derived read models (product_listings, deals, specials) from the
// authoritative archive tables. Run once after each daily collection so the
// site serves every deal-feed / browse request as a bounded indexed read.
//
// Usage: node scripts/rebuild-read-model.js [path/to/archive.db]

import { SqliteArchiveRepository } from '../src/archive-factory.js';

const dbPath = process.argv[2]
  || process.env.PRICE_ARCHIVE_FILE
  || new URL('../data/archive.db', import.meta.url).pathname;

const repo = new SqliteArchiveRepository(dbPath);
try {
  const t0 = Date.now();
  const listings = repo.rebuildListings(); // also rebuilds deals + specials
  console.log(`Rebuilt read model for ${dbPath} in ${Date.now() - t0}ms`);
  console.log(`  product_listings rows: ${listings}`);
  console.log(`  deals rows:            ${repo.deals({ freshWithinDays: 3650, minDropPercent: 0, limit: 1000 }).length}+`);
  console.log(`  specials (served):     ${repo.advertisedSpecials({ limit: 300 }).length}`);
} finally {
  repo.close();
}
