#!/usr/bin/env node
// Boots the real app server (src/app/server.js) as a child process and measures
// cold-boot time plus per-endpoint latency (sequential + one concurrent burst).
// Read-only against the archive; writes only throwaway DBs under data/.
// Usage: node tools/bench-server.js [--port 3117] [--reps 30] [--json <path>]
//   env: JSONL_PATH (default data/prices.jsonl), PRICES_DB (default data/prices.db)

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (name, def) => {
  let i = args.indexOf(name);
  return i >= 0 ? args[++i] : def;
};
const PORT = parseInt(argOf('--port', '3117'), 10);
const REPS = parseInt(argOf('--reps', '30'), 10);
const JSON_OUT = argOf('--json', null);
const JSONL = process.env.JSONL_PATH || join(ROOT, 'data', 'prices.jsonl');
const PRICES_DB = process.env.PRICES_DB || join(ROOT, 'data', 'prices.db');
const APP_DB = process.env.APP_DB || join(ROOT, 'data', 'app.db');
const BASE = `http://127.0.0.1:${PORT}`;

const timings = {};
function timed(ms) { timings.ms = performance.now() - ms; }

async function waitForServer(deadlineMs) {
  const t0 = performance.now();
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return performance.now() - t0;
    } catch {}
    if (performance.now() - t0 > deadlineMs) throw new Error('server did not start');
    await new Promise(r => setTimeout(r, 50));
  }
}

const stats = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return {
    n: arr.length,
    min: +s[0].toFixed(2),
    p50: +s[Math.floor(s.length / 2)].toFixed(2),
    p95: +s[Math.ceil(s.length * 0.95) - 1].toFixed(2),
    max: +s[s.length - 1].toFixed(2),
    mean: +mean.toFixed(2),
  };
};

async function bench(name, path, reps = REPS) {
  const samples = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(30000) });
    const body = await res.arrayBuffer();
    samples.push(performance.now() - t0);
    if (i === 0) timings[name] = { path, status: res.status, bytes: body.byteLength };
  }
  return stats(samples);
}

async function burst(name, path, concurrency = 8, rounds = 5) {
  const t0 = performance.now();
  const all = [];
  for (let r = 0; r < rounds; r++) {
    all.push(...await Promise.all(Array.from({ length: concurrency }, () => (async () => {
      const s = performance.now();
      const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(30000) });
      await res.arrayBuffer();
      return performance.now() - s;
    })())));
  }
  const wall = performance.now() - t0;
  return { ...stats(all), wallMs: +wall.toFixed(1), rps: +((concurrency * rounds) / (wall / 1000)).toFixed(1) };
}

mkdirSync(dirname(PRICES_DB), { recursive: true });
const child = spawn(process.execPath, [join(ROOT, 'src', 'app', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', JSONL_PATH: JSONL, PRICES_DB: PRICES_DB, APP_DB: APP_DB },
  stdio: ['ignore', 'inherit', 'inherit'],
  cwd: ROOT,
});

try {
  const bootMs = await waitForServer(120000);
  await new Promise(r => setTimeout(r, 300)); // let startup settle

  // discover a real product id + query term from the first products page
  const first = await (await fetch(`${BASE}/api/products?limit=1`)).json();
  const productId = first?.products?.[0]?.productId ?? first?.products?.[0]?.id ?? '';

  const results = {
    bootMs: +bootMs.toFixed(1),
    endpoints: {
      'health': await bench('health', '/api/health'),
      'deals': await bench('deals', '/api/deals'),
      'products search=milk': await bench('products_search', '/api/products?search=milk&limit=20'),
      'suggestions query=mil': await bench('suggestions', '/api/search/suggestions?query=mil'),
      'stores': await bench('stores', '/api/stores'),
      ...(productId ? { 'product history': await bench('history', `/api/products/${encodeURIComponent(productId)}/history`) } : {}),
      'SPA index.html': await bench('index', '/'),
      'style.css': await bench('css', '/style.css'),
    },
    bursts: {
      'deals 8x5': await burst('deals', '/api/deals'),
    },
  };
  console.log(JSON.stringify(results, null, 2));
  if (JSON_OUT) writeFileSync(resolve(JSON_OUT), JSON.stringify(results, null, 2));
} finally {
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 200));
  try { child.kill('SIGKILL'); } catch {}
}
