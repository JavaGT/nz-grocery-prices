# perf-trial 2026-09-09 — Subagent C ("matching") report

Branch `perf-trial-2026-09-09T085133-matching` (worktree), baseline `ad636e0`.
Scope: cross-retailer product matching pipeline (`scripts/matching-cli.js`,
i.e. `npm run matching -- --fuzzy`). NOTE: `perf-notes/REPORT.md` in this
worktree is Subagent A's (lib) committed report that arrived via shared
history — this file is kept separate to avoid clobbering it.

Throwaway artifacts: `/tmp/perf-trial-matching/` only (projection DBs built
from the real archive read-only; app DBs created fresh in /tmp). The main
checkout, real `data/`, and sibling worktrees were never touched. Node v26.7.0.

## Headline results (wall time, `--fuzzy`, fresh app DB, median of 3)

| Scale | Baseline | After | Delta |
|---|---|---|---|
| 12 MB archive (8,916 products) | 0.16 s (0.15–0.18) | **0.07 s** (0.07–0.10) | **−56%** |
| merged 87.6 MB / 140,475 records (42,702 products, 18,132 GTINs) | 0.30 s (0.30–0.37) | **0.14 s** (0.14–0.19) | **−53%** |

Already-fast baseline (sub-second at both scales), so this is a "profiled,
cut roughly in half, stopped honestly" outcome, not a rescue.

Workload shape at merged scale: auto phase finds 587 pairs (GTIN + source_id),
fuzzy phase hits the 1,000-candidate batch cap after scoring only 2,126 pairs
across 33 brand groups (of 5,255 brand groups; 35 skipped as oversized).
Pair-table totals reconcile exactly: 587 + 1000 − 6 overlaps = 1,581 rows
(12 MB: 30 + 1000 − 3 = 1,027).

## Baseline profile (`--cpu-prof`, merged scale, 286 ms sampled)

| Hotspot | Self time | Share |
|---|---|---|
| `createMatchPair` app-db.js (per-pair `prepare()` + INSERT) | 93.2 ms | 32.6% |
| `prepareProductsForFuzzy` spread arrow matcher.js:115 | 30.1 ms | 10.5% |
| GC | 28.4 ms | 9.9% |
| product SELECT `.all()` (matching-cli main) | 22.5 ms | 7.9% |
| tokenizeName filter closures (normalize.js:32) | 16.5 ms | 5.8% |
| `getMatchPair` app-db.js (per-pair prepare + SELECT) | 13.5 ms | 4.7% |
| findGtinMatches / findSourceIdMatches / findFuzzyCandidates | 24.8 ms | 8.7% |

Two structural problems, both fixed:

1. **~1,500 pair writes each compiled their own SQL and each ran as its own
   autocommit WAL transaction.** `node:sqlite` `prepare()` recompiles every
   call, and autocommit means an fsync-ish commit per pair.
2. **All 42,702 products were spread-copied and tokenized before fuzzy
   scoring, although the batch cap stops the scan after ~33 groups.**

## Changes (commit bff4180, one commit)

- `src/sqlite/app-db.js` — `#prepareMatchPairStatement` caches the three
  match-pair statements (`getMatchPair`, `createMatchPair`, `updateMatchPair`);
  new `runInTransaction(fn)` (BEGIN IMMEDIATE / COMMIT, ROLLBACK on throw).
  One-shot methods keep plain `prepare()`.
- `src/matching/orchestrator.js` — `#persistMatches` wraps the pair loop in
  one transaction via `runInTransaction` (feature-detected: injectable doubles
  without the method fall back to direct writes; empty batches skip it).
  Per-pair error accounting unchanged — SQLite ABORT resolution aborts only
  the failing statement, so the loop still counts `errors[]` and continues.
- `src/matching/matcher.js` — `findFuzzyCandidates` groups **raw** products by
  normalized brand first, then prepares (spread+tokenize) each group only when
  scored. Same grouping key (`normalizeBrand(brand) || '__no_brand__'`), same
  Map insertion order, same scorable filter, same cap semantics.
  `prepareProductsForFuzzy` keeps its exact contract (now maps a per-product
  `prepareProductForFuzzy`).
- `src/matching/normalize.js` — `tokenizeName` merges the two `.filter`
  passes into one loop over the split parts (byte-identical output: replace
  punctuation with space → split on whitespace → length>1 → not stop word).
- `scripts/matching-cli.js` — dropped unused `category` from the product
  SELECT (no matcher reads it; 42.7k strings not materialized).

## Post-change profile (merged scale; steady-state runs ~141–149 ms sampled)

| Hotspot | Before | After |
|---|---|---|
| createMatchPair | 93.2 ms | **7.8 ms** |
| prepare spread | 30.1 ms | 12.5–18 ms (only scored groups) |
| GC | 28.4 ms | 20–29 ms (noisy) |
| product SELECT | 22.5 ms | 21–26 ms (irreducible without output changes) |
| getMatchPair | 13.5 ms | <2 ms (absorbed, no longer top-14) |
| tokenizeName | 24 ms incl. filters | 8–13 ms |

First post-change profile showed `main` at 82 ms — a cold-cache outlier;
three re-profiles settled at 21–26 ms. Remaining time is Node boot, the
42.7k-row projection SELECT, and residual GC: not worth chasing for a CLI
that finishes in 0.14 s.

## Parity evidence (byte-for-byte outputs, both scales)

- Baseline extracted via `git archive ad636e0` to `/tmp/baseline-matching`
  (full repo, own CLI invocation, same throwaway projection DBs).
- **stdout JSON** (`{auto:{inserted,skipped}}`, `{fuzzy:…}`): `diff` clean
  baseline vs after, fresh DBs, both scales; deterministic across 3 runs each.
- **`product_match_pairs` table dumps** (product_a_id, product_b_id,
  match_method, algorithm_version, confidence, review_state, provenance,
  input_evidence_hash — sorted by pair): byte-identical baseline vs after at
  both scales, i.e. identical pair set, ordering, confidence floats, and every
  sha256 evidence hash. Only `created_at` (wall clock) differs; it is excluded
  by the comparison.
- **Rerun/skip path**: baseline then after, sequentially on the same populated
  DB → identical stdout (`auto inserted 6 / skipped 581`, fuzzy re-updates its
  1,000 candidates in both). This also exercises `updateMatchPair`.
- Fuzzy candidates remain `review_state:'candidate'`, `provenance:'system'`,
  returned/persisted separately — never confirmed (asserted by existing tests).

## Verification

- `npm run check` — green.
- `node --test test/matching/*.test.js` — 75/75 pass (61 existing + 6 new:
  `test/matching/fuzzy-preparation.test.js` pins lazy-prep equivalence,
  `__no_brand__` grouping, evidence-hash stability, no input mutation;
  `test/matching/orchestrator-batching.test.js` pins the no-`runInTransaction`
  fallback seam and per-pair error isolation inside a transaction).
- Full `npm test` — **1020/1020 pass, 0 fail** (1014 at baseline + 6 new).

## Deliberately NOT done (profile said no)

- Precomputed token Sets / quantity parse / brand compare per pair in
  `fuzz.js`: only 2,126 pairs are scored before the cap; jaccard self-time
  ~1.5 ms. Would change public function signatures for milliseconds.
- Micro-optimizing GTIN/source_id grouping loops (~15 ms self combined):
  semantics risk out of proportion.
- Loading the whole existing `product_match_pairs` table into a Map to replace
  per-pair lookups: the cached-statement SELECT inside one transaction is
  already µs-scale, and a full-table load would trade memory at real app.db
  scale for nothing.
- Raising `FUZZY_BATCH_CAP` / touching thresholds, scores, or the
  candidate-never-confirmed rule: matching semantics are frozen for this trial.

## Observations for the coordinator (pre-existing behavior, unchanged)

1. Fuzzy reruns re-UPDATE all 1,000 candidates every run (no
   candidate+same-hash skip condition; only confirmed/rejected skip). A
   `candidate`-state skip would make reruns near-free — semantic change,
   out of scope here. Adopt/Adapt/Reject: ______
2. On fresh runs, fuzzy candidates overwrite 6 auto-confirmed pairs at merged
   scale (existing pair + different evidence hash → falls through to UPDATE,
   confirmed→candidate). Looks unintended; both code paths do it identically.
   Adopt/Adapt/Reject: ______
3. `docs/agent/verification.md` says "~600 tests"; actual is 1020. Stale
   before my change. Adopt/Adapt/Reject: ______

No `docs/agent/*` updates were required: no commands, ownership, env vars, or
verification paths changed (tests are glob-discovered).
