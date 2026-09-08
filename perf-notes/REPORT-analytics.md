# perf-trial 2026-09-09 — analytics lane report

Branch `perf-trial-2026-09-09T100601-analytics` (worktree), baseline `ed961d2`
(contains spa + ingest lanes). Scope: `src/analytics.js` only (`calculateSales`,
`calculateOngoingSales`, `buildPriceSeries`, `toAgentFeed`). Node v26.7.0.
All benches offline against copies in `/tmp/analytics-perf/`: `prices.jsonl`
(12.6 MB, 9,428 observations), `merged-40.jsonl` (37.6 MB, 32,410 obs;
prices + breadth-pilot + tw + fc), `merged-87.jsonl` (87.6 MB, 80,759 obs;
prices + all five breadth archives). The shared checkout was only read. No
live network commands.

## Where analytics actually runs (context that shaped the lane)

- `/api/deals` serves pre-materialized `deal_signals` rows (handler switch
  landed `e58303b`) — analytics is OFF the request path for deals.
- The product history endpoint (`public.js getProductHistory`) reads the
  projection DB directly and never calls `buildPriceSeries`.
- The production-scale consumer is therefore **rebuild-time**
  `materializeDealSignals` (nightly, over the 90-day window) plus the public
  `PriceArchive`/`agentFeed` surface used by legacy scripts.

## Profile findings (baseline `--cpu-prof`, 30 loops x all passes, 80.8k obs)

~8.4 s of the 9.1 s sample was analytics. Self-time hotspots:

| Hotspot | Self ms | Share of sample | Root cause |
|---|---|---|---|
| `groupObservations` | 1,562 | 17% | redundant `groups.set` per repeat observation |
| `hasParseableObservedAt` | 1,144 | 13% | re-parses the same `observedAt` in every filter |
| `calculateOngoingSales` | 1,063 | 12% | filter chain + `[...candidates].sort` re-parses |
| `byObservedAt` comparator | 1,055 | 12% | `Date.parse` per comparison — O(n log n) parses per group |
| `buildPriceSeries` + point map | 1,177 | 13% | same parse-in-comparator pattern |
| `structuredClone` (outputs) | ~594 | 7% | product/store/promotion per sale |
| GC | 532 | 6% | serving the above allocations |
| `selectEffectivePrice` | 320 | 4% | array + spreads per call |

## Changes

### Commit `7598410` — parse each timestamp once, pre-epoch sorts, fused passes, cloneJson outputs

All in `src/analytics.js`, all output-identical:

1. **Decorate-sort-undecorate everywhere.** Groups build `[epochMs, obs]`
   pairs once (`byEpoch` comparator); sorts never re-parse timestamps. The
   old code parsed inside comparators (O(n log n) parses) and re-parsed in
   every subsequent filter.
2. **`selectEffectivePrice` takes `atMs`** (the epoch callers already hold)
   instead of an ISO string, and builds candidates with sequential
   strict-lower comparisons instead of array+spread+reduce. Tie order
   (regular > promo > member) is preserved — this is the same reduce
   semantics without the allocations.
3. **`calculateSales` single pass over previous**: one fused
   parseable+productIds filter pass, then one loop computing the baseline
   window sum (same ascending summation order as the old
   `baseline.map().reduce()` — `average` is bit-identical) and a running min
   over ALL previous (equals `Math.min(...allPreviousPrices)`). Kills the
   double `selectEffectivePrice` per baseline observation.
4. **`calculateOngoingSales` fused candidate loop** (the old
   parseable→fresh→retailer→store→product chain was pure predicates, so
   folding preserves the set and order), decorated stable sort, and one
   output loop instead of filter/filter/map.
5. **`groupObservations`** no longer re-`set`s the group on every hit.
6. **Output clones via `cloneJson`** (`src/archive-records.js`, import only —
   that file is untouched): per-value `structuredClone` fallback preserved,
   so non-plain values stay on the old path; only cycles differ (both throw
   before anything is returned).

### Commit `f452073` — A/B harness + revert of the `effectiveCents` twin

`perf-notes/evidence/ab-analytics.mjs` runs two analytics modules
alternately in ONE process over the same observations (side order alternates
per rep) so sibling-lane machine noise cancels, asserting byte-identical
outputs in-process. It measured the commit-`7598410` `effectiveCents`
cents-only twin: **−4.1% sales / −3.4% ongoing / +1.7% series** — edge of
noise for ~1% of a full sweep, not worth a duplicated semantic that must be
kept in sync. Reverted; `selectEffectivePrice` remains the single source.

## Before/after (interleaved in-process A/B, baseline `ed961d2` vs final, 15 reps, outputs byte-identical)

| Pass | 12.6 MB / 9.4k obs | 37.6 MB / 32.4k obs | 87.6 MB / 80.8k obs |
|---|---|---|---|
| `calculateSales` | 3.96 → 3.40 ms (**−14%**) | 20.51 → 17.05 ms (**−17%**) | 58.31 → 44.45 ms (**−24%**) |
| `calculateOngoingSales` | 44.31 → 15.46 ms (**−65%**) | 35.72 → 20.35 ms (**−43%**) | 81.64 → 51.01 ms (**−38%**) |
| `buildPriceSeries` (all) | 11.69 → 9.27 ms (**−21%**) | 38.35 → 31.73 ms (**−17%**) | 101.08 → 81.12 ms (**−20%**) |
| Full sweep | 59.96 → 28.13 ms (**−53%**) | 94.58 → 69.13 ms (**−27%**) | 241.03 → 176.58 ms (**−27%**) |

Scale curve: roughly linear in observation count for sales/series (8.6x obs ≈
13–14x ms pre-change, 11–13x post — group sizes grow, sorts are n log n);
`calculateOngoingSales` scales mostly with SURVIVING output count (8,865
outputs at 12.6 MB where `at` sits inside the data vs 1,632 at 87.6 MB), so
its per-archive numbers are not directly comparable across scales.

Already-optimal verdicts (profiled, left alone):

- **`toAgentFeed`: 0.1–0.8 ms** at every scale — payload assembly is one
  object per sale, no intermediates to remove. Optimal.
- **Per-product `buildPriceSeries`: 0.03–0.08 ms** for the five busiest
  products (4–10 observations each — offers have thin histories at current
  data). Optimal; and the history endpoint doesn't use it anyway.
- **Honest absolute framing**: analytics now runs at rebuild time only. A
  27–53% relative win is ~30–65 ms per nightly rebuild at today-to-87 MB
  scale — real but small next to the ~0.3–0.5 s rebuild. The wins matter
  more if analytics ever returns to a request path.

## Behavior-preservation evidence

- `perf-notes/evidence/parity-analytics.mjs`: baseline (`git show ed961d2`)
  vs current over all three real archives — `calculateSales`,
  `calculateOngoingSales`, `toAgentFeed`, `buildPriceSeries` (full + per
  product, default + member/non-default params) — **2,131 comparisons,
  0 mismatches** (JSON.stringify byte equality, sha-diffed on mismatch).
  Plus a seeded 300-case fuzz over edge semantics: price ties, undefined
  promo/member cents, promotion windows incl. missing bounds, member
  policy, garbage `observedAt`, `lastSeenAt`, duplicate timestamps,
  cross-retailer grouping; plus `parseRequiredAt` throw-message parity.
  NaN-epoch rows are filtered before every sort in BOTH versions, so the
  decorated stable sorts reproduce the old order exactly (ties = input
  order, V8 stable).
- `npm run check` clean. `node --test test/analytics.test.js
  test/sqlite/deal-materialization.test.js` → 35 pass. Full `npm test`:
  **1,033/1,033 pass** (incl. deal-materialization parity — the rebuild's
  DEAL_SIGNAL_PARAMS semantics unchanged).

## Trade-offs accepted

- `src/analytics.js` now imports `cloneJson` from `archive-records.js`
  (first import in that module; no cycle — archive-records imports only
  node:crypto). Cyclic input now fails with a stack overflow instead of
  `DataCloneError`; both throw, nothing is returned either way (documented
  in code and in archive-records itself).
- Output objects are plain-JSON copies where they used to be
  structuredClones — identical for every JSON-shaped observation (which is
  the contract: observations come from JSONL), per-value fallback otherwise.

## Rejected ideas (with evidence)

- **`effectiveCents` cents-only twin**: −4% on one pass, ~1% of a sweep —
  duplication not worth it; reverted (see above).
- **Nested product→store Maps instead of `\u0000` string keys** in
  `groupObservations`: changes group iteration order (pair first-encounter
  vs product first-encounter), which flows through the stable
  dropPercent-tie sort into `calculateSales` output order — breaks byte
  parity. Rejected.
- **Module-level `WeakMap` epoch memo across calls**: would halve the
  remaining parse cost for the rebuild's sales+ongoing double pass over the
  same array, but analytics is a pure public API taking caller-owned
  objects; a cross-call cache is only sound if callers never mutate
  `observedAt` between calls — a contract change needing an owner decision
  (see below).
- **Faster line-level JSON parsing**: not my surface (repository layer);
  ingest lane already evaluated it at ~4.5% of load.

## Opportunities found, NOT taken (for the coordinator to ticket)

1. **`query()` materialization still uses `structuredClone`**
   (`src/archive-index.js`, ingest lane's ticket #1 — lines ~39, 125, 420,
   486–496): re-confirmed in this lane's profile — 302+64 ms self time in a
   6.3 s sample, the single largest analytics-adjacent item left, sitting on
   the `repository.query()` path that feeds every analytics bench and the
   legacy runtime paths. Swap to `cloneJson` (ingest-lane proven).
2. **Cross-call epoch memoization** (owner decision above): est. −15–25% on
   the materialization double pass if the purity contract is extended.
3. `decodeArchiveLine`/`JSON.parse` (4–5% of load): high-risk micro
   territory, restated from ingest lane.

## Proposed downstream one-liners (outside my ownership)

- `src/archive-index.js` query-materialization clone sites → `cloneJson(...)`
  (ticket 1). No analytics-side downstream edits are needed for my changes:
  signatures and output shapes are unchanged.

## docs/agent updates

None needed: no command, structure, ownership, env-var, or verification-path
changes (benches live under `perf-notes/`, tests are glob-discovered).
