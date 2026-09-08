#!/usr/bin/env node
// Endurance bench — SERVER side. Runs the real app server in this process and
// samples its memory on a timer so a separate driver process can generate
// traffic without polluting the measured heap.
//
// Launched by perf-notes/run-endurance.js as:
//   node --expose-gc perf-notes/bench-endurance-server.js <samplesFile> <portFile> [stopFile]
//
// - Samples are JSON lines written (sync) to <samplesFile>:
//   {t, rss, heapUsed, external, arrayBuffers, gc, phase}
//   `t` is ms since process start; `gc` is true when the sample was taken
//   right after a full global.gc() (post-GC retained memory). `phase` marks
//   boot / warmup / load so the driver can split the boot peak from the
//   steady-state curve.
// - The listen port is written to <portFile> once bound.
// - When [stopFile] appears (or SIGTERM arrives) it takes a final post-GC
//   sample, stops the server, closes the DBs, and exits 0 (a clean exit also
//   lets --heap-prof flush its profile).
//
// Bench-only harness: console loggers are stubbed so per-request logs don't
// flood stdout; nothing here ships in src/.

import { appendFileSync, writeFileSync, existsSync } from 'node:fs';

const [samplesFile, portFile, stopFile] = process.argv.slice(2);
if (!samplesFile || !portFile) {
  console.error('usage: bench-endurance-server.js <samplesFile> <portFile> [stopFile]');
  process.exit(1);
}

const t0 = performance.now();
let phase = 'boot';

// The Server logs one line per request to console; stub it so a 100k-request
// run doesn't flood stdout (bench-only harness, not src/ behavior).
console.log = () => {};
console.info = () => {};
console.error = () => {};
console.warn = () => {};

function sample({ gc = false } = {}) {
  if (gc && typeof globalThis.gc === 'function') globalThis.gc();
  const m = process.memoryUsage();
  appendFileSync(samplesFile, JSON.stringify({
    t: Math.round(performance.now() - t0),
    phase,
    gc,
    rss: m.rss,
    heapUsed: m.heapUsed,
    external: m.external,
    arrayBuffers: m.arrayBuffers,
  }) + '\n');
}

// High-frequency boot sampling: dynamic import keeps the sampler running
// while the app modules load, so the boot peak (module graph + DB open) is
// captured rather than hidden behind synchronous imports.
sample({ gc: true });
const bootTimer = setInterval(() => sample(), 10);

const { createAppServer } = await import('../src/app/server.js');

const app = createAppServer(); // env: PRICES_DB / APP_DB / JSONL_PATH
clearInterval(bootTimer);
phase = 'listen';
sample({ gc: true });

const port = await app.server.start(0);
writeFileSync(portFile, String(port));
process.stdout.write(`PORT=${port}\n`);

phase = 'load';
// Warmup samples continue at bench cadence from here; the driver controls
// when traffic starts/stops and reads the samples file at the end.
const cadence = setInterval(() => sample({ gc: true }), 250);

async function shutdown(signal) {
  clearInterval(cadence);
  phase = 'shutdown';
  sample({ gc: true });
  // server.stop() waits for every open keep-alive connection; a bench client
  // parks sockets, so bound the wait and exit anyway (samples are already
  // flushed to disk synchronously).
  await Promise.race([
    app.server.stop(),
    new Promise(r => setTimeout(r, 1500)),
  ]);
  try { app.appDb.close(); } catch {}
  try { app.projDb?.close(); } catch {}
  process.stdout.write(`STOPPED signal=${signal}\n`);
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
if (stopFile) {
  const stopWatch = setInterval(() => {
    if (existsSync(stopFile)) {
      clearInterval(stopWatch);
      shutdown('stopfile');
    }
  }, 100);
  stopWatch.unref();
}
