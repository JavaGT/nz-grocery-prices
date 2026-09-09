#!/usr/bin/env node
// spa-lane boot composition profile: where does process spawn -> listening
// time go? Measures (in child processes, medians of N):
//   1. bare node spawn (runtime baseline)
//   2. module import only (server graph, no DB)
//   3. import + AppDatabase open/migrations (app.db)
//   4. import + full createAppServer() (projection open + handlers + routes)
//   5. full main() path spawn -> /api/health responds
// Read-only against /tmp/perf-spa fixtures.
//
// Usage: node perf-notes/bench-spa-boot.js [--reps 15]

import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (name, def) => {
  let i = args.indexOf(name);
  return i >= 0 ? args[++i] : def;
};
const REPS = parseInt(argOf('--reps', '15'), 10);
const PORT = 3123;

const CHILD_TEMPLATE = `
const t0 = performance.now();
const phase = process.argv[2];
const want = async () => {
  if (phase === 'bare') return;
  await import('./src/server/server.js');
  await import('./src/app/auth.js');
  await import('./src/server/handlers/public.js');
  await import('./src/server/handlers/private.js');
  if (phase === 'import') return;
  const { AppDatabase } = await import('./src/sqlite/app-db.js');
  const { Auth } = await import('./src/app/auth.js');
  if (phase === 'appdb') { new AppDatabase('/tmp/perf-spa/app.db'); return; }
  const { createAppServer } = await import('./src/app/server.js');
  if (phase === 'compose') { createAppServer(); return; }
  if (phase === 'full') {
    const { server } = createAppServer();
    await server.start(0);
  }
};
await want();
console.log((performance.now() - t0).toFixed(2));
`;

const med = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return +s[Math.floor(s.length / 2)].toFixed(1);
};

function runChild(phase) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['--input-type=module', '-e', CHILD_TEMPLATE, phase], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), PRICES_DB: '/tmp/perf-spa/prices.db', APP_DB: '/tmp/perf-spa/app.db' },
    });
    let out = '';
    c.stdout.on('data', d => { out += d; });
    c.on('exit', () => resolve(parseFloat(out.trim())));
    c.on('error', reject);
  });
}

const phases = ['bare', 'import', 'appdb', 'compose', 'full'];
const results = {};
for (const p of phases) {
  const samples = [];
  for (let i = 0; i < REPS; i++) samples.push(await runChild(p));
  results[p] = med(samples);
  process.stdout.write(`${String(med(samples)).padStart(8)} ms  ${p}\n`);
}
process.stdout.write(`\nincremental: modules=${(results.import - results.bare).toFixed(1)} appDb=${(results.appdb - results.import).toFixed(1)} compose(+projection+handlers)=${(results.compose - results.appdb).toFixed(1)} listen=${(results.full - results.compose).toFixed(1)}\n`);
