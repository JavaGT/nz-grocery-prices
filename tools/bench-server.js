#!/usr/bin/env node
// Boots the real app server (src/app/server.js) as a child process and measures
// cold-boot time plus per-endpoint latency (sequential + one concurrent burst).
// Read-only against the archive; writes only throwaway DBs under data/.
// Usage: node tools/bench-server.js [--port 3117] [--reps 30] [--json <path>]
//                                      [--accept-encoding 'gzip, deflate, br'] [--quiet]
//   env: JSONL_PATH (default data/prices.jsonl), PRICES_DB (default data/prices.db)
//
// Payload measurement: every endpoint result reports wireBytes (the
// content-length actually shipped, i.e. compressed when an encoding was
// negotiated) and rawBytes (the same request with accept-encoding: identity),
// so latency and payload size are always read side by side. Latency samples
// are sent with the negotiated Accept-Encoding (default: a browser-like
// 'gzip, deflate, br') — pass --accept-encoding '' to reproduce the
// uncompressed wire.

import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
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
// '' (empty string) means identity: no accept-encoding header at all.
const ACCEPT = argOf('--accept-encoding', 'gzip, deflate, br');
const QUIET = args.includes('--quiet');
const JSONL = process.env.JSONL_PATH || join(ROOT, 'data', 'prices.jsonl');
const PRICES_DB = process.env.PRICES_DB || join(ROOT, 'data', 'prices.db');
const APP_DB = process.env.APP_DB || join(ROOT, 'data', 'app.db');
const BASE = `http://127.0.0.1:${PORT}`;

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
    // Chronological first sample: surfaces warm-up effects (connections,
    // statement/page-cache priming) that the sorted stats hide.
    first: +arr[0].toFixed(2),
    min: +s[0].toFixed(2),
    p50: +s[Math.floor(s.length / 2)].toFixed(2),
    p95: +s[Math.ceil(s.length * 0.95) - 1].toFixed(2),
    max: +s[s.length - 1].toFixed(2),
    mean: +mean.toFixed(2),
  };
};

// One measured request; returns { ms, wire, encoding }. Wire size is the
// content-length the server shipped (encoded bytes), falling back to the body
// length when a chunked/proxy path drops the header.
async function once(path) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}${path}`, {
    signal: AbortSignal.timeout(30000),
    headers: ACCEPT ? { 'accept-encoding': ACCEPT } : undefined,
  });
  const body = await res.arrayBuffer();
  const ms = performance.now() - t0;
  const cl = res.headers.get('content-length');
  return {
    ms,
    wire: cl !== null ? Number(cl) : body.byteLength,
    body: body.byteLength,
    encoding: res.headers.get('content-encoding'),
    status: res.status,
  };
}

async function bench(path, reps = REPS) {
  const samples = [];
  let head = null;
  for (let i = 0; i < reps; i++) {
    const r = await once(path);
    samples.push(r.ms);
    if (i === 0) head = r;
  }
  // Uncompressed size probe: one identity request so rawBytes is reported next
  // to wireBytes even when the timed samples negotiate an encoding.
  let raw = head.body;
  if (ACCEPT) {
    try {
      const t0 = performance.now();
      const res = await fetch(`${BASE}${path}`, {
        signal: AbortSignal.timeout(30000),
        headers: { 'accept-encoding': 'identity' },
      });
      await res.arrayBuffer();
      const cl = res.headers.get('content-length');
      if (cl !== null) raw = Number(cl);
    } catch {}
  }
  return {
    path,
    status: head.status,
    encoding: head.encoding || 'identity',
    wireBytes: head.wire,
    rawBytes: raw,
    ...stats(samples),
  };
}

async function burst(path, concurrency = 8, rounds = 5) {
  const t0 = performance.now();
  const all = [];
  for (let r = 0; r < rounds; r++) {
    all.push(...await Promise.all(Array.from({ length: concurrency }, () => (async () => {
      const r = await once(path);
      return r.ms;
    })())));
  }
  const wall = performance.now() - t0;
  return { ...stats(all), wallMs: +wall.toFixed(1), rps: +((concurrency * rounds) / (wall / 1000)).toFixed(1) };
}

mkdirSync(dirname(PRICES_DB), { recursive: true });
const child = spawn(process.execPath, [join(ROOT, 'src', 'app', 'server.js')], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', JSONL_PATH: JSONL, PRICES_DB: PRICES_DB, APP_DB: APP_DB },
  stdio: QUIET ? ['ignore', 'ignore', 'inherit'] : ['ignore', 'inherit', 'inherit'],
  cwd: ROOT,
});

try {
  const bootMs = await waitForServer(120000);
  await new Promise(r => setTimeout(r, 300)); // let startup settle

  // In dist mode (public-dist/ present) the server serves content-hashed
  // URLs, so the static benches must request the hashed names the browser
  // actually loads (resolved via the build manifest).
  const staticPaths = { '/': '/', '/style.css': '/style.css', '/app.js': '/app.js' };
  try {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'public-dist', 'manifest.json'), 'utf8'));
    if (manifest['style.css']) staticPaths['/style.css'] = '/' + manifest['style.css'];
    if (manifest['app.js']) staticPaths['/app.js'] = '/' + manifest['app.js'];
  } catch {}

  // discover a real product id + query term from the first products page
  const first = await (await fetch(`${BASE}/api/products?limit=1`)).json();
  const productId = first?.products?.[0]?.productId ?? first?.products?.[0]?.id ?? '';

  const results = {
    acceptEncoding: ACCEPT || 'identity',
    staticMode: existsSync(join(ROOT, 'public-dist')) ? 'public-dist (immutable)' : 'public (dev)',
    bootMs: +bootMs.toFixed(1),
    endpoints: {
      'health': await bench('/api/health'),
      'deals': await bench('/api/deals'),
      'products search=milk': await bench('/api/products?search=milk&limit=20'),
      'suggestions query=mil': await bench('/api/search/suggestions?query=mil'),
      'stores': await bench('/api/stores'),
      ...(productId ? { 'product history': await bench(`/api/products/${encodeURIComponent(productId)}/history`) } : {}),
      'SPA index.html': await bench(staticPaths['/']),
      'style.css': await bench(staticPaths['/style.css']),
      'app.js': await bench(staticPaths['/app.js']),
    },
    bursts: {
      'deals 8x5': await burst('/api/deals'),
      'suggestions 8x5': await burst('/api/search/suggestions?query=mil'),
    },
  };
  console.log(JSON.stringify(results, null, 2));
  if (JSON_OUT) writeFileSync(resolve(JSON_OUT), JSON.stringify(results, null, 2));
} finally {
  child.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 200));
  try { child.kill('SIGKILL'); } catch {}
}
