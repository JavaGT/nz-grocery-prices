#!/usr/bin/env node
// Builds throwaway bench fixtures under /tmp/perf-spa for the spa-lane perf
// benches. Offline: reads the projection source JSONL (default: the shared
// checkout's data/prices.jsonl), rebuilds a projection DB from it, and creates
// an app DB seeded with one user + session + watch list + saved searches.
//
// Never touches any real DB: outputs go to OUT_DIR (default /tmp/perf-spa).
// Usage: node perf-notes/seed-spa-fixtures.js [--jsonl <path>] [--out <dir>]

import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { ProjectionRepository } from '../src/sqlite/projection-repository.js';
import { AppDatabase } from '../src/sqlite/app-db.js';
import { Auth } from '../src/app/auth.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[++i] : def;
};
const JSONL = resolve(argOf('--jsonl', '/Users/server/Development/nz-grocery-prices/data/prices.jsonl'));
const OUT = resolve(argOf('--out', '/tmp/perf-spa'));

if (!existsSync(JSONL)) {
  console.error(`source archive not found: ${JSONL}`);
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });
for (const f of ['prices.db', 'app.db', 'prices.db-lock']) {
  const p = join(OUT, f);
  if (existsSync(p)) rmSync(p);
}

process.stdout.write(`rebuilding projection DB from ${JSONL} ...\n`);
const t0 = performance.now();
const repo = new ProjectionRepository(JSONL, join(OUT, 'prices.db'));
await repo.rebuild({ force: true });
repo.close();
process.stdout.write(`projection rebuilt in ${((performance.now() - t0) / 1000).toFixed(1)}s\n`);

process.stdout.write('seeding app DB ...\n');
const appDb = new AppDatabase(join(OUT, 'app.db'));
const auth = new Auth(appDb);

// The bench user owns a watch list (2 products + 1 category), 2 preferred
// stores, and 3 saved searches — enough to exercise every authenticated read
// path. The session token is fixed so the bench can send it as a cookie.
const user = await auth.register('benchuser', 'bench-password-1');
const watch = [
  ['product', 'paknsave:283248', 'Benchmark watch product'],
  ['product', 'newworld:50026', 'Second watched product'],
  ['category', 'category:milk', 'Milk category'],
];
for (const [kind, id, label] of watch) appDb.addWatchListEntry(user.id, kind, id, label);
appDb.setStorePreference(user.id, 1, 1);
appDb.setStorePreference(user.id, 2, 2);
for (let i = 0; i < 3; i++) {
  appDb.createSavedSearch(user.id, `Bench search ${i}`, `butter query ${i}`, null, null,
    `seedhash${i}`.padEnd(64, '0'));
}
// A session valid for the whole bench run; token hash = sha256(raw token).
const token = randomBytes(32).toString('hex');
const { createHash } = await import('node:crypto');
appDb.createSession(user.id, createHash('sha256').update(token).digest('hex'),
  Date.now() + 24 * 60 * 60 * 1000);

const counts = {
  products: appDb.db.prepare('SELECT COUNT(*) c FROM users').get().c,
  sessions: appDb.db.prepare('SELECT COUNT(*) c FROM sessions').get().c,
  watch: appDb.db.prepare('SELECT COUNT(*) c FROM watch_list_entries').get().c,
  searches: appDb.db.prepare('SELECT COUNT(*) c FROM saved_searches').get().c,
};
appDb.close();

process.stdout.write(`fixtures ready in ${OUT}\n`);
process.stdout.write(`BENCH_SID=${token}\n`);
process.stdout.write(`app rows: ${JSON.stringify(counts)}\n`);
