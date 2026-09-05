# Lane B2 — Scale Projection (2x archive) Report

Branch: `perf-trial-20260906-0839-scale` · 2026-09-06 · Node 26.7.0, zero-dep ESM
Scope owned: `src/server/handlers/public.js`, `test/server/public-api.test.js`,
`test/server/deals-cache.test.js`, new test files. Everything else read-only.

## Verdict

**Query handlers do not degrade super-linearly at 2x archive scale.** Warm
paths are flat; the cold deals compute is linear in window rows and was the
only path worth touching. I shaved ~11-19% off it (mapping layer) and proved a
candidate index that converts the cold deals cost from O(total archive) to
O(90-day window) — the load-bearing property once nightly breadth collection
starts multiplying archive size.

Nothing breached the >10x rule; nothing degraded non-linearly.

## Scale fixtures (built in this worktree, gitignored)

| DB | archive | records imported | offer_revisions | products | size |
|---|---|---|---|---|---|
| `data/current.db` | prices.jsonl (reference) | 18,726 | 9,428 | 8,916 | 13MB |
| `data/scale-nw.db` | breadth-pilot-nw.jsonl | 35,139 | 20,492 | 14,943 | 29MB |
| `data/scale-ww.db` | breadth-pilot-ww.jsonl | 35,071 | 17,564 | 17,557 | 26MB |

All timestamps in the pilots span 2026-08-27 → 2026-09-05, so the 90-day
deals window covers 100% of rows today. Raw archives untouched (read-only).

## Standard harness (tools/bench-server.js --reps 30, loopback p50 ms)

Before-fix runs: `scale-bench-current.json` / `scale-bench-{nw,ww}-before.json`;
after-fix: `scale-bench-{current,nw,ww}-after.json` (all in reports/perf-trial/).

| endpoint | current | nw 2x | ww 2x | after fix (cur/nw/ww) |
|---|---|---|---|---|
| boot | 70.9 | 71.8 | 71.1 | 74.0 / 73.7 / 74.9 |
| deals (warm) | 0.29 | 0.26 | 0.82 | 0.27 / 0.31 / 0.93 |
| products search=milk | 0.83 | 1.32 | 1.23 | 1.05 / 1.51 / 1.69 |
| suggestions q=mil* | 0.22 | 0.24 | 0.23 | flat |
| stores | 0.34 | 0.23 | 0.22 | flat |
| product history | 0.22 | 0.23 | 0.22 | flat |
| deals burst 8x5 | 0.48 p50 | 0.85 | ~1 | flat |

\* **Harness caveat:** the bench and prior lane baselines request
`/api/search/suggestions?q=...`, but the handler and the real frontend client
(`public/api.js`) use `?query=`. The `q=` runs measure a 400 fast-path
(0.2 ms), not the feature. Real 200-latency measured separately: 0.8-0.95 ms
current → 1.1-1.64 ms at 2x (linear, still ~1.5 ms absolute). Recommend the
coordinator fix the harness param (tools/ is not my file).

## Edge probes (10 reps each, before fix; cold deals via DEALS_CACHE_TTL_MS=0)

| probe | current | nw 2x | ww 2x | read |
|---|---|---|---|---|
| deals COLD p50 | 57.4 | 132.2 | 129.9 | linear (2.2x rows → 2.3x); bench "max 247ms" is first-request JIT, not steady state |
| deals?retailer COLD p50 | 46.0 | 128.1 | 128.2 | per-retailer key recomputes from the same window |
| search=milk limit=120 p50 | 2.17 | 2.77 | 2.00 | COUNT + SELECT double scan, linear |
| search deep offset (last page) | 6.93 | 10.94 | 10.51 | OFFSET walk, linear; no keyset pagination without API change |
| search offset beyond total | 6.35 | 4.52 | 3.70 | cheap (COUNT dominates) |
| suggestions query= (real) | 0.80-0.95 | 1.11-1.31 | 1.40-1.64 | linear |
| history, most-revised product | 0.41 | 0.39 | 0.37 | flat (indexed by product_id, LIMIT 200) |
| product detail (correlated MAX) | 0.38 | 0.56 | 0.41 | flat |
| warm deals long-TTL p50 | 0.60 | 0.67 | 1.86 | ww payload 62KB JSON (5,320 advertised) dominates |

## Fix: cold-compute mapping (`defaultQueryDbObservations`)

Component split at scale-nw before the fix: **SQL ~72 ms + JS mapping ~33 ms +
analytics ~23 ms**. (An earlier "mapping is 105 ms" reading was wrong — the
function includes its own SQL.) Analytics and caching untouched, per mission.

Changes, all output-identical (verified with `deepStrictEqual` + per-row key
order against the previous implementation on all three DBs):

1. ISO timestamp strings memoized per epoch-ms (collections stamp thousands of
   revisions with the same run timestamp — 5-31 distinct values per archive)
   instead of `new Date(...).toISOString()` twice per row.
2. `promotion_data` parsed only when it will actually attach
   (reduction + blob present), not speculatively.
3. Conditional spread `...(cond ? {promotion} : {})` replaced with plain
   assignment (identical key order; spread form breaks V8 object-shape
   monomorphism at 20k rows).

In-process A/B (median of 7, warm, full function incl. SQL):
current **43.7 → 35.8 ms**, scale-nw **112.0 → 91.9 ms** (−18%).

End-to-end cold deals p50 (TTL=0 probe): current **57.4 → 46.2 ms**,
nw **132.2 → 116.7 ms**, ww **129.9 → 115.8 ms**. Warm deals unchanged.

New `test/server/query-observations.test.js` (4 tests) pins the contract:
window ordering, optional cents, comparative parsing, promotion attachment
iff reduction + promotion data, shared-timestamp ISO reuse.

## Index recommendation for the coordinator (src/sqlite lane)

```sql
CREATE INDEX IF NOT EXISTS idx_or_observed ON offer_revisions(observed_at);
```

Measured on a scratch copy of `data/scale-nw.db` (index NOT added to any
schema — `src/sqlite` is another lane's):

- BEFORE plan (exact deals query): `SCAN or2 USING INDEX idx_or_product` …
  `USE TEMP B-TREE FOR ORDER BY` — full-table behavior.
- AFTER plan: `SEARCH or2 USING INDEX idx_or_observed
  (observed_at>? AND observed_at<?)` — range scan, sort eliminated.
- As-built scale-nw (window = 100% of rows): window query 59.8 → **34.0 ms** (−43%).
- Current archive: 28.3 → **19.0 ms** (−33%).
- **Simulated 4-month archive** (scratch copy with each row re-observed at
  ±45/60/90 days: 81,968 total rows, window still 20,492 = 25% of table):
  no index **63.9 ms** (scales with TOTAL archive), with index **32.3 ms**
  (scales with WINDOW only). This is the decisive property: without the index,
  nightly accumulation makes every cold deals compute slower forever; with it,
  cost is bounded by the 90-day window regardless of archive age.
- Cost: 296 KB per 20,492 revisions; build 3 ms; planner picks it without
  ANALYZE (verified via EXPLAIN QUERY PLAN).

Home for it: a new projection migration in `src/sqlite/migrations/projection/`.

## Trade-offs

- ISO memoization allocates a small Map per query call (bounded by distinct
  timestamps, ≤ dozens) — cheap insurance as archives grow.
- Skipped a lazy `comparative` getter (analytics never reads it; would save
  ~3 ms) — not worth turning the observation shape into accessors.
- Deep pagination left as-is: linear OFFSET walk, 10.9 ms worst case at 2x;
  fixing it properly means keyset pagination (API change, out of scope).
- ww warm deals (1.86 ms/62 KB) is payload-serialization bound at 5,320
  advertised deals — fine now; a response cap would be a product decision.

## Verification

- `npm run check` — pass.
- `node --test test/server/*.test.js` — 141 pass, 0 fail (+4 new).
- `npm test` — **910 tests, 0 failures**.
- Scale DBs, probe JSONs, and bench JSONs left in place for re-verification
  (`data/*.db` and `reports/perf-trial/*.json` gitignored; JSONs force-added).

## Commits

- `c6e2cd5` perf: cut cold deals observation-mapping cost ~18% (ISO
  memoization, no conditional spread) — public.js + new test file.
- (this commit) perf-trial scale report + bench JSONs.
