# UI/HTTP performance trial — subagent B ("ui") report

Branch `perf-trial-2026-09-09T085133-ui`, baseline `fcfed0e`.
Commits: `06f0692` (server + bench), `bfab763` (static sidecars + bench dist mode).

All numbers: throwaway projection DB at `/tmp/perf-trial-ui/prices.db` (18,726
archive records, 8,916 products, 5 price contexts, 9,428 offer revisions,
`deal_signals` empty — same as the trial baseline, so comparisons are
apples-to-apples). Bench = `node tools/bench-server.js --port 3119 --reps 20`,
2+ runs per configuration, medians reported. Run-to-run noise: p50 ±0.1–0.15 ms,
burst rps ±10 %. JSON samples in `perf-notes/samples/`.

## State of the baseline (important context)

The baseline commit already contained substantial transport work: dynamic JSON
brotli-q5/gzip with a 1,024 B threshold, static gzip/brotli (lazily compressed,
cached per file version), weak ETag/304, `Cache-Control` dev vs immutable
dist, the `CachedResponse` encoded-bytes cache for /api/deals, and the
content-hashed `build:assets`. The mission brief's "add compression if absent"
was therefore already satisfied; this trial measured it, surfaced its blind
spots, and improved what was measurably left.

## Change 1 — bench now measures bytes (and browser-true requests)

`tools/bench-server.js`:

- Every endpoint now reports `wireBytes` (content-length actually shipped),
  `rawBytes` (same request with `accept-encoding: identity`), and the
  negotiated `encoding`. Previously the recorded first-sample byte count was
  never surfaced in the results, and the bench sent **no Accept-Encoding**, so
  every baseline latency was an uncompressed-wire number — not what browsers
  experience.
- Default request header is now browser-like `gzip, deflate, br`
  (`--accept-encoding identity` / `''` to override). Note: `''` is NOT
  identity — undici auto-negotiates gzip when the header is absent; use
  `identity` explicitly.
- Reports chronological `first` ms per endpoint (surfaces warm-up effects the
  sorted stats hide), benches `app.js`, adds a suggestions 8x5 burst, resolves
  static URLs through `public-dist/manifest.json` when dist exists, and prints
  the active static mode. `--quiet` silences child request logs.

Wire bytes discovered (before my server changes, dev mode):

| endpoint        | encoding | wire B | raw B | saved |
|-----------------|----------|-------:|------:|------:|
| products search | br       |  1,110 | 6,674 | 83%   |
| stores          | br       |    521 | 1,317 | 60%   |
| style.css       | br       |  3,528 |17,602 | 80%   |
| app.js          | br       |    843 | 2,860 | 71%   |
| index.html      | br       |    455 | 1,477 | 69%   |
| health          | identity |    461 |   461 | threshold |
| deals           | identity |    351 |   351 | threshold |
| suggestions     | identity |    775 |   775 | threshold |
| product history | identity |    944 |   944 | threshold |

Small JSON bodies (<1,024 B MIN_COMPRESS_BYTES) ship identity by design. Kept:
compressing a 351–944 B body burns per-request CPU to save a few hundred bytes
including header overhead.

## Change 2 — suggestions: in-memory index (`06f0692`)

Why it was slowest: `SELECT DISTINCT name FROM products WHERE name LIKE ? COLLATE
NOCASE ORDER BY name LIMIT 10` is a full-table scan + DISTINCT + sort on every
request (measured 0.58 ms SQL alone), and it serialized the event loop under
concurrency (8x5 burst: p50 3.73 ms, ~1,283 rps). Schema work is owned by the
other agent, so the fix is handler-level:

- Distinct product names (~8.8k strings, a few hundred KB) are cached in
  memory at first use, ASCII-folded (`COLLATE NOCASE` folds A–Z only), in the
  SQLite `ORDER BY name` order, invalidated by the same `dbSignature` (DB
  mtime) probe the deals cache uses.
- Wildcard-free queries (the per-keystroke case) match in memory and stop at
  LIMIT 10 — exact semantic mirror of the SQL for those inputs. Queries
  containing `%`, `_`, or `\` keep the original SQL path bit-for-bit.

| metric                  | before | after (median of 2) |
|-------------------------|-------:|--------------------:|
| p50 ms                  |   1.01 |                0.27 |
| 8x5 burst p50 ms        |   3.73 |                0.51 |
| 8x5 burst rps           |  1,283 |               9,556 |

Trade-off: the first suggestions request after boot/rebuild pays a one-time
~12 ms index build (`first` column shows it). A startup pre-warm would remove
that; skipped to keep boot side-effect-free (possible follow-up).

## Change 3 — one `_meta` read per request (`06f0692`)

Every JSON response embedded `_freshness`, and the health handler re-read it;
`Server.#handle` computed `#projMeta()` for the ctx AND again per respond
path — 2–3 identical `_meta` queries per request. Now `#handle` memoizes one
per request (lazily — static fallbacks still pay zero) and threads it through
ctx/health/respond paths. Response shapes unchanged (test-pinned).

Effect (same code otherwise): products search p50 0.72→0.66/0.54, p95
1.49→0.87 across runs; history p95 0.35→0.28. Small but free, and it removes
per-request SQLite work on every JSON endpoint.

## Change 4 — precompressed static sidecars (`bfab763`)

Lazy static brotli cost 12.5 ms on the first `style.css` request after boot
(q11 on 17.6 KB). `build:assets` now emits `.br` (brotli max) + `.gz` (level
9) siblings for every dist file; the dist static server loads them per file
version and skips lazy compression. Dev `public/` unchanged (lazy path, no
sidecars). Verified in dist mode: style.css first hit 12.5 ms → 0.64 ms at the
same 3,528 B (lazy was already q11, so bytes identical — this is a
first-hit-latency win, plus it removes per-file compression at boot of each
new version).

Tests: build-assets sidecar emission + round-trip decode; dist-static serves
the shipped sidecar byte-for-byte (raw `node:http` — `fetch` transparently
decompresses br, which is also why bench wire sizes come from content-length)
and falls back to lazy when no sidecar exists.

## Health p95 outlier (3.49 ms) — investigated, not a server cost

Server-side logs during the bench show `GET /api/health 200 0–1 ms`; the bench
now records chronological `first` per endpoint and every endpoint's first
sample lands 2–14 ms (client connection/undici + first-touch of that route).
With n=20, p95 is the 2nd-highest sample, so a single elevated first sample
sets p95. Not fixed server-side because there is nothing real to fix; the
`first` column keeps it visible.

## SPA payload — measured, split rejected

Full SPA (13 files): 67,889 B raw → 17,598 B over brotli. JS-only: 48,810 →
13,615 B. The default view's dependency set covers most of the graph, so
dynamic-importing "heavy" views would save at most ~4–5 KB wire on first paint
while breaking the modulepreload waterfall contract (`index-preloads.test.js`)
and adding request churn. Chose NOT to split — evidence over instinct.

## Chose NOT to do (with reasons)

- **Schema/index changes for suggestions** — not mine to make; handler cache
  removed the need.
- **zstd encoding** — br already ships 80–83 % savings; a third variant adds
  cache/test surface for ~1–3 % more.
- **Lowering MIN_COMPRESS_BYTES** — sub-KB JSON gains <300 B for per-request
  CPU; deliberate baseline threshold kept.
- **Startup warm-up of the suggestion index** — possible follow-up; boot
  currently does no projection reads and stays that way.
- **API Cache-Control headers** — would change caching semantics (tests + .d.ts
  surface gate); out of scope.
- **DEALS_CACHE_TTL_MS memoization** — untouched, still in effect.

## Verification

- `npm run check` — clean.
- Targeted: `test/server/` 172 pass, `test/app/ + test/frontend/` 80 pass.
- Full `npm test` — **1,017 tests, 0 failures** (3.06 s).
- `npm run build:assets` run in the worktree; dist-mode bench verified
  (hashed URLs resolved via manifest, sidecars served); generated
  `public-dist/` deleted afterwards; `.gitignore` line 16 covers it. `git
  status` clean except this report.

## Headline before/after (p50 ms, browser-mode wire)

| endpoint          | before      | after (median) | wire bytes      |
|-------------------|------------:|---------------:|-----------------|
| suggestions       | 1.01        | 0.27           | 775 (identity)  |
| suggestions 8x5   | 3.73 / 1,283 rps | 0.51 / 9,556 rps | —       |
| products search   | 0.72        | 0.66           | 6,674 → 1,110   |
| stores            | 0.37        | 0.40           | 1,317 → 521     |
| history           | 0.25        | 0.23           | 944 (identity)  |
| deals             | 0.40        | 0.39           | 351 (identity)  |
| style.css first   | 12.5 (dev lazy / dist lazy) | 0.64 (dist sidecar) | 3,528 |

Compression CPU cost (identity vs br p50 on identical code): products 0.39 →
0.66 ms (+0.27 ms per response for −83 % bytes); static is one-time per file
version. Worth it for any non-loopback client.

## For the coordinator

- `docs/agent/*` are read-only in this trial and were NOT edited. Post-merge
  they need: bench flag docs (`--accept-encoding`, `--quiet`, byte columns) in
  `command-map.md`, and the build:assets sidecar behavior in
  `maintenance.md`/`project-map.md` (one line each).
- deals burst rps reads ~7,300 (identity) to ~8,800 (br) vs mission 6,260 —
  run noise dominates single-digit-ms wall times; don't over-read.
- `deal_signals` is empty in rebuilds from this archive, so /api/deals serves
  an empty universe in all runs (baseline included). If materialization should
  qualify deals for this archive, that's a question for the lib lane.
