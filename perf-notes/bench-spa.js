#!/usr/bin/env node
// spa-lane HTTP bench: boots the real app server (src/app/server.js) as a
// child process against the seeded /tmp/perf-spa fixtures and measures cold
// boot + per-endpoint latency for BOTH the anonymous and the authenticated
// (sid cookie) request paths, plus a static-asset sample.
//
// Usage:
//   node perf-notes/seed-spa-fixtures.js                  # build fixtures once
//   BENCH_SID=<token from seeder> node perf-notes/bench-spa.js [--port 3121]
//       [--reps 40] [--json <out>] [--quiet]
//
// Read-only against the fixtures except the auth DB copy the server opens
// (WAL sidecars land in /tmp/perf-spa).

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (name, def) => {
  let i = args.indexOf(name);
  return i >= 0 ? args[++i] : def;
};
const PORT = parseInt(argOf('--port', '3121'), 10);
const REPS = parseInt(argOf('--reps', '40'), 10);
const JSON_OUT = argOf('--json', null);
const QUIET = args.includes('--quiet');
const SID = process.env.BENCH_SID;
if (!SID) {
  console.error('BENCH_SID missing — run perf-notes/seed-spa-fixtures.js and pass the printed token');
  process.exit(1);
}
const BASE = `http://127.0.0.1:${PORT}`;
const ACCEPT = 'gzip, deflate, br';

const stats = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return {
    n: arr.length,
    first: +arr[0].toFixed(3),
    min: +s[0].toFixed(3),
    p50: +s[Math.floor(s.length / 2)].toFixed(3),
    p95: +s[Math.ceil(s.length * 0.95) - 1].toFixed(3),
    max: +s[s.length - 1].toFixed(3),
    mean: +mean.toFixed(3),
  };
};

async function once(path, { cookie } = {}) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    signal: AbortSignal.timeout(30000),
    headers: {
      'accept-encoding': ACCEPT,
      ...(cookie ? { cookie } : {}),
    },
  });
  const body = await res.arrayBuffer();
  const ms = performance.now() - t0;
  const cl = res.headers.get('content-length');
  return {
    ms,
    wire: cl !== null ? Number(cl) : body.byteLength,
    encoding: res.headers.get('content-encoding'),
    status: res.status,
  };
}

async function bench(path, opts = {}) {
  const samples = [];
  let head = null;
  for (let i = 0; i < REPS; i++) {
    const r = await once(path, opts);
    if (!QUIET && (r.status >= 400)) process.stderr.write(`  WARN ${r.status} ${path}\n`);
    samples.push(r.ms);
    if (i === 0) head = r;
  }
  return { path, authed: !!opts.cookie, status: head.status, wireBytes: head.wire, ...stats(samples) };
}

const child = spawn(process.execPath, [join(ROOT, 'src', 'app', 'server.js')], {
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    PRICES_DB: '/tmp/perf-spa/prices.db',
    APP_DB: '/tmp/perf-spa/app.db',
  },
  stdio: QUIET ? 'ignore' : ['ignore', 'inherit', 'inherit'],
});
const bootT0 = performance.now();
let bootMs = null;
for (;;) {
  try {
    const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) });
    if (res.ok) { bootMs = performance.now() - bootT0; break; }
  } catch {}
  if (performance.now() - bootT0 > 20000) { console.error('server did not start'); process.exit(1); }
  await new Promise(r => setTimeout(r, 20));
}

// Warm connections/routes before sampling.
await once('/api/health');
await once('/api/deals', { cookie: `sid=${SID}` });

const cookie = `sid=${SID}`;
const results = [];
const endpoints = [
  ['/api/health', {}],
  ['/api/products?query=butter&limit=42', {}],
  ['/api/products?limit=42', {}],
  ['/api/products/freshchoice:66d7a43014c2c345d47bb54e', {}],
  ['/api/products/freshchoice:66d7a43014c2c345d47bb54e/history', {}],
  ['/api/stores', {}],
  ['/api/search/suggestions?query=but', {}],
  ['/api/deals', {}],
  ['/api/deals', { cookie }],
  ['/api/watch-list', { cookie }],
  ['/api/preferred-stores', { cookie }],
  ['/api/saved-searches', { cookie }],
  ['/api/new-products', { cookie }],
];
for (const [p, opts] of endpoints) {
  const r = await bench(p, opts);
  results.push(r);
  process.stdout.write(`${r.p50.toFixed(2).padStart(7)} ms p50  (p95 ${r.p95.toFixed(2)}, wire ${r.wireBytes} B)  ${opts.cookie ? 'AUTH ' : 'anon'}  ${p}\n`);
}

// Authenticated deals burst (8 concurrent x 5 rounds) — the tiering path.
{
  const t0 = performance.now();
  let n = 0;
  for (let round = 0; round < 5; round++) {
    const batch = Array.from({ length: 8 }, () => once('/api/deals', { cookie }).then(r => { n++; return r; }));
    await Promise.all(batch);
  }
  const wall = performance.now() - t0;
  results.push({ path: '/api/deals burst 8x5', authed: true, p50: +(wall / n).toFixed(3), rps: Math.round(n / (wall / 1000)) });
  process.stdout.write(`${(wall / n).toFixed(2).padStart(7)} ms avg (burst 8x5, ~${Math.round(n / (wall / 1000))} rps)  AUTH  /api/deals\n`);
}

// Static assets in dev mode.
for (const p of ['/app.js', '/style.css', '/views/browse.js']) {
  const r = await bench(p);
  results.push({ path: p, static: true, status: r.status, wireBytes: r.wireBytes, ...stats(r ? [r.p50] : []) });
  process.stdout.write(`${r.p50.toFixed(2).padStart(7)} ms p50  (wire ${r.wireBytes} B)  static ${p}\n`);
}

const payload = { bootMs: +bootMs.toFixed(1), reps: REPS, results };
process.stdout.write(`\ncold boot (spawn -> healthy): ${bootMs.toFixed(1)} ms\n`);
if (JSON_OUT) {
  writeFileSync(JSON_OUT, JSON.stringify(payload, null, 2));
  process.stdout.write(`json written to ${JSON_OUT}\n`);
}

child.kill('SIGTERM');
await new Promise(r => setTimeout(r, 150));
try { child.kill('SIGKILL'); } catch {}
process.exit(0);
