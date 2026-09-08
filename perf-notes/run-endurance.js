#!/usr/bin/env node
// Endurance bench — DRIVER. Spawns the real app server (perf-notes/
// bench-endurance-server.js) against throwaway /tmp fixture DBs, drives a
// sustained mixed workload (anonymous + authenticated + static + 404 paths),
// then reduces the server's RSS samples into a before/after table.
//
// Offline: loopback only, ephemeral port, clean shutdown, no background
// processes. Fixtures come from perf-notes/seed-spa-fixtures.js (never the
// real data/ DBs).
//
// Usage:
//   node perf-notes/run-endurance.js [--minutes 3] [--label baseline]
//        [--out perf-notes/samples/endurance-<label>.json]
//        [--heap-prof] [--warmup-seconds 20]

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : def;
};
const hasFlag = name => args.includes(name);

const MINUTES = Number(argOf('--minutes', '3'));
const LABEL = argOf('--label', `run-${Date.now()}`);
const WARMUP_S = Number(argOf('--warmup-seconds', '20'));
const FIXTURES = resolve(argOf('--fixtures', '/tmp/perf-endurance'));
const SAMPLES_DIR = join(ROOT, 'perf-notes', 'samples');

for (const f of ['prices.db', 'app.db']) {
  if (!existsSync(join(FIXTURES, f))) {
    console.error(`missing fixture ${join(FIXTURES, f)} — run perf-notes/seed-spa-fixtures.js --out ${FIXTURES} first`);
    process.exit(1);
  }
}

const workDir = join('/tmp', `perf-endurance-run-${process.pid}`);
mkdirSync(workDir, { recursive: true });
const samplesFile = join(workDir, 'samples.jsonl');
const portFile = join(workDir, 'port');
const stopFile = join(workDir, 'stop');
for (const f of [samplesFile, portFile, stopFile]) rmSync(f, { force: true });

const childArgs = [join(ROOT, 'perf-notes', 'bench-endurance-server.js'), samplesFile, portFile, stopFile];
if (hasFlag('--heap-prof')) {
  // Keep the profile OUT of the worktree AND out of the deleted run dir:
  // profiles land in /tmp/perf-endurance-profiles for inspection.
  const profDir = '/tmp/perf-endurance-profiles';
  mkdirSync(profDir, { recursive: true });
  childArgs.unshift(`--heap-prof-dir=${profDir}`, '--heap-prof');
}
let sawStopped = false;
const child = spawn(process.execPath, childArgs, {
  env: {
    ...process.env,
    PRICES_DB: join(FIXTURES, 'prices.db'),
    APP_DB: join(FIXTURES, 'app.db'),
    JSONL_PATH: join(FIXTURES, 'prices.db'), // present, so no rebuild is attempted
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', d => {
  const s = String(d);
  if (s.startsWith('PORT=')) console.error(s.trim());
  if (s.includes('STOPPED')) sawStopped = true;
});
child.stderr.on('data', d => console.error('[server-err]', String(d).trim()));

// Wait for the port file (server bound).
const deadline = Date.now() + 30_000;
while (!existsSync(portFile)) {
  if (Date.now() > deadline) { console.error('server did not bind in 30s'); child.kill('SIGKILL'); process.exit(1); }
  await new Promise(r => setTimeout(r, 25));
}
const PORT = readFileSync(portFile, 'utf8').trim();
const BASE = `http://127.0.0.1:${PORT}`;

// Fixed bench session seeded by seed-spa-fixtures.js (authed paths).
const BENCH_SID = process.env.BENCH_SID;
if (!BENCH_SID) {
  console.error('BENCH_SID env not set (printed by seed-spa-fixtures.js)');
  child.kill('SIGTERM'); process.exit(1);
}
const SID_COOKIE = `sid=${BENCH_SID}`;

// --- workload -------------------------------------------------------------
// Product IDs / queries are drawn from the seeded projection universe
// (paknsave/newworld/woolworths/freshchoice/warehouse contexts). Rotating
// ids/queries keep every per-request cache key distinct, which is the
// worst case for any unbounded client/server cache.
const RETAILERS = ['paknsave', 'newworld', 'woolworths', 'freshchoice', 'warehouse'];
const SEARCH_TERMS = [
  'butter', 'milk', 'bread', 'eggs', 'cheese', 'yoghurt', 'chicken', 'beef',
  'rice', 'pasta', 'coffee', 'tea', 'sugar', 'flour', 'oil', 'beans',
  'tomato', 'apple', 'banana', 'wash', 'clean', 'paper', 'dog', 'cat',
  'cola', 'juice', 'water', 'chips', 'chocolate', 'biscuit',
];
const PREFIXES = ['bu', 'mi', 'br', 'ch', 'ap', 'wa', 'to', 'co', 'fr', 'gl'];

async function seedLookups() {
  // Discover 200 real product ids + a deal-capable retailer set once.
  const ids = [];
  for (const term of SEARCH_TERMS) {
    const res = await fetch(`${BASE}/api/products?query=${encodeURIComponent(term)}&limit=200`);
    const body = await res.json();
    for (const p of body.products || []) ids.push(p.id);
    if (ids.length >= 400) break;
  }
  return ids.length > 0 ? ids : [];
}

let PRODUCT_IDS = await seedLookups();
if (PRODUCT_IDS.length === 0) {
  console.error('no products found via /api/products — fixture universe empty?');
  child.kill('SIGTERM'); process.exit(1);
}

let n = 0;
let statusCounts = {};
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// One weighted request. Weights favour reads the SPA actually makes on a
// browse session; authed reads use the seeded session cookie.
async function oneRequest() {
  n++;
  const id = pick(PRODUCT_IDS);
  const path = (() => {
    const k = n % 100;
    if (k < 20) return `/api/products?query=${encodeURIComponent(pick(SEARCH_TERMS))}`;
    if (k < 28) return `/api/products?query=${encodeURIComponent(pick(SEARCH_TERMS))}&retailer=${pick(RETAILERS)}`;
    if (k < 38) return `/api/products/${id}`;
    if (k < 48) return `/api/products/${id}/history`;
    if (k < 53) return '/api/stores';
    if (k < 60) return `/api/search/suggestions?query=${pick(PREFIXES)}`;
    if (k < 63) return '/api/health';
    if (k < 68) return `/api/deals?retailer=${pick(RETAILERS)}`;
    if (k < 80) return '/api/deals';
    // authenticated reads (sid cookie)
    if (k < 84) return '/api/watch-list';
    if (k < 87) return '/api/preferred-stores';
    if (k < 90) return '/api/saved-searches';
    if (k < 94) return '/api/deals'; // authed tiered path
    if (k < 96) return '/';
    if (k < 98) return pick(['/app.js', '/style.css', '/utils/dom.js', '/components/card.js']);
    if (k === 98) return '/favicon.ico'; // 404
    return '/browse'; // SPA nav fallback -> index.html
  })();

  const authed = n % 100 >= 80 && n % 100 < 94;
  const headers = authed ? { cookie: SID_COOKIE } : {};
  const res = await fetch(`${BASE}${path}`, { headers });
  if (res.ok && path.includes('/api/')) await res.json(); // drain body like a client would
  else res.body?.cancel().catch(() => {});
  statusCounts[res.status] = (statusCounts[res.status] || 0) + 1;
}

// Occasional login/logout cycles exercise scrypt + session insert/delete.
// LOGIN rate limit is 20/min per IP, so keep this well under it.
async function authCycle(i) {
  const username = `endurance${i % 3}`;
  const password = 'endurance-password-1';
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  }); // 409 after first run is fine — login is what matters
  await reg.body?.cancel();
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  statusCounts['login:' + res.status] = (statusCounts['login:' + res.status] || 0) + 1;
  const body = await res.json().catch(() => null);
  const sid = body?.user && res.headers.get('set-cookie')?.match(/sid=([a-f0-9]{64})/)?.[1];
  if (sid) {
    await fetch(`${BASE}/api/watch-list`, { headers: { cookie: `sid=${sid}` } });
    await fetch(`${BASE}/api/auth/logout`, { method: 'POST', headers: { cookie: `sid=${sid}` } });
  }
}

// --- run ------------------------------------------------------------------
console.error(`warming up ${WARMUP_S}s (suggestion index + statement caches) ...`);
const warmupEnd = Date.now() + WARMUP_S * 1000;
while (Date.now() < warmupEnd) await oneRequest();

console.error(`load: ${MINUTES}min mixed workload ...`);
const endAt = Date.now() + MINUTES * 60_000;
let nextAuthCycle = 0;
while (Date.now() < endAt) {
  await oneRequest();
  if (n >= nextAuthCycle) { await authCycle(Math.floor(n / 1500)); nextAuthCycle = n + 1500; }
}

// Graceful stop via stopfile; child takes a final post-GC sample on the way
// out (clean exit also flushes --heap-prof).
const exited = new Promise(r => { if (child.exitCode !== null) r(true); else child.on('exit', () => r(true)); });
writeFileSync(stopFile, 'stop\n');
// STOPPED on stdout can be dropped by the child's process.exit on a pipe, so
// wait on the process exit itself.
const stopDeadline = Date.now() + 15_000;
let done = await Promise.race([exited, false]);
while (!done && Date.now() < stopDeadline) {
  await new Promise(r => setTimeout(r, 50));
  done = await Promise.race([exited, false]);
}
if (!done) { console.error('child missed stopfile; SIGTERM'); try { child.kill('SIGTERM'); } catch {} }
await exited;

// --- reduce ---------------------------------------------------------------
const lines = readFileSync(samplesFile, 'utf8').trim().split('\n').map(JSON.parse);
const mb = v => Math.round(v / 1048576 * 10) / 10;
const boot = lines.filter(l => l.phase === 'boot');
const warmup = lines.filter(l => l.phase === 'load' && l.t < WARMUP_S * 1000);
const load = lines.filter(l => l.phase === 'load' && l.t >= WARMUP_S * 1000);
const median = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// Post-GC RSS in thirds of the load window: growth = last third − first third.
function thirds(arr) {
  const k = Math.floor(arr.length / 3);
  return [arr.slice(0, k), arr.slice(k, 2 * k), arr.slice(2 * k)].map(a => median(a.map(l => l.rss)));
}
const [t1, t2, t3] = thirds(load);

const summary = {
  label: LABEL,
  minutes: MINUTES,
  requests: n,
  statusCounts,
  bootPeakRssMB: mb(Math.max(...boot.map(l => l.rss))),
  bootPeakAtMs: boot.reduce((a, l) => (l.rss > (a.rss || 0) ? l : a), boot[0] || {}).t,
  postBootRssMB: mb(median(warmup.map(l => l.rss))),
  steadyRssMB: { firstThird: mb(t1), middleThird: mb(t2), lastThird: mb(t3) },
  growthMB: mb(t3 - t1),
  loadPostGcRssMedianMB: mb(median(load.map(l => l.rss))),
  lastSample: lines[lines.length - 1],
};

mkdirSync(SAMPLES_DIR, { recursive: true });
const outFile = argOf('--out', join(SAMPLES_DIR, `endurance-${LABEL}.json`));
writeFileSync(outFile, JSON.stringify({ summary, perSample: lines.map(l => ({ t: l.t, phase: l.phase, gc: l.gc, rssMB: mb(l.rss), heapUsedMB: mb(l.heapUsed) })) }, null, 1));
rmSync(workDir, { recursive: true, force: true });

console.log(JSON.stringify(summary, null, 2));
console.error(`samples: ${outFile}`);
