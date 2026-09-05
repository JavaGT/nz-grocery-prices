#!/usr/bin/env node
// Renders reports/perf-trial/findings.json into a self-contained HTML report.
// The page auto-refreshes every 5 minutes so the owner can just leave it open.
// Usage: node tools/perf-report.js  (run from anywhere; paths are file-relative)

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'reports', 'perf-trial', 'findings.json');
const OUT = join(HERE, '..', 'reports', 'perf-trial', 'index.html');

const d = JSON.parse(readFileSync(DATA, 'utf8'));

const esc = (s) => String(s ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const rows = (items, cols) => items.map(it => `<tr>${cols.map(c => `<td>${esc(it[c])}</td>`).join('')}</tr>`).join('\n');

const improvements = d.improvements.map((im, i) => `
  <div class="card">
    <h3>#${i + 1} · ${esc(im.title)} <span class="pill ${esc(im.state)}">${esc(im.state)}</span></h3>
    <p>${esc(im.what)}</p>
    <table class="kv">
      <tr><th>Area</th><td>${esc(im.area)}</td></tr>
      <tr><th>Before → After</th><td><b>${esc(im.beforeAfter)}</b></td></tr>
      <tr><th>Trade-offs</th><td>${esc(im.tradeoffs)}</td></tr>
      <tr><th>Verified by</th><td>${esc(im.verified)}</td></tr>
      <tr><th>Commit</th><td><code>${esc(im.commit)}</code></td></tr>
    </table>
  </div>`).join('\n') || '<p class="muted">No merged improvements yet.</p>';

const agents = d.agents.map(a => `
  <tr><td>${esc(a.name)}</td><td>${esc(a.area)}</td><td><span class="pill ${esc(a.status)}">${esc(a.status)}</span></td><td>${esc(a.notes)}</td></tr>`).join('\n') || '<tr><td colspan="4" class="muted">none running</td></tr>';

const next = d.next.map(n => `<li>${esc(n)}</li>`).join('\n') || '<li class="muted">—</li>';
const stops = d.stops.map(n => `<li>${esc(n)}</li>`).join('\n') || '';

const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="300">
<title>${esc(d.title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: -apple-system, "Helvetica Neue", sans-serif; max-width: 980px; margin: 2rem auto; padding: 0 1.2rem 4rem; line-height: 1.5; }
  h1 { margin-bottom: 0.1rem; } h2 { margin-top: 2.2rem; border-bottom: 1px solid #8884; padding-bottom: 0.25rem; }
  .meta { color: #888; margin-top: 0; }
  table { border-collapse: collapse; width: 100%; margin: 0.6rem 0; }
  th, td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid #8883; vertical-align: top; }
  th { color: #888; font-weight: 600; font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.04em; }
  code, .mono { font-family: ui-monospace, Menlo, monospace; font-size: 0.92em; }
  .card { border: 1px solid #8884; border-radius: 10px; padding: 0.9rem 1.1rem; margin: 0.9rem 0; }
  .card h3 { margin: 0 0 0.4rem; }
  .kv { margin: 0; } .kv th { width: 130px; text-transform: none; font-size: 0.9rem; letter-spacing: 0; }
  .pill { display: inline-block; font-size: 0.75rem; border-radius: 99px; padding: 0.05rem 0.6rem; vertical-align: middle; background: #8882; }
  .pill.merged, .pill.done, .pill.pass { background: #2e7d3240; }
  .pill.running, .pill.measuring { background: #b58a2b40; }
  .pill.blocked, .pill.failed { background: #c2454540; }
  .muted { color: #888; }
  .banner { border-left: 4px solid #888; padding: 0.5rem 0.9rem; background: #8881; border-radius: 0 8px 8px 0; }
</style>
</head><body>
<h1>${esc(d.title)}</h1>
<p class="meta">${esc(d.repo)} · started ${esc(d.started)} · report updated ${esc(d.updated)} · <b>status: ${esc(d.status)}</b> · auto-refreshes every 5 min</p>
<div class="banner">${esc(d.summary)}</div>

<h2>Baseline (before any changes)</h2>
<table>
  <tr><th>Metric</th><th>Value</th><th>Notes</th></tr>
  ${rows(d.baselines, ['metric', 'value', 'notes'])}
</table>

<h2>Improvements</h2>
${improvements}

<h2>Subagents (max 2 concurrent)</h2>
<table>
  <tr><th>Name</th><th>Area</th><th>Status</th><th>Notes</th></tr>
  ${agents}
</table>

<h2>Measured, deliberately not changed (honest stops)</h2>
<ul>${stops}</ul>

<h2>Up next</h2>
<ul>${next}</ul>
</body></html>`;

writeFileSync(OUT, html);
console.log(`wrote ${OUT}`);
