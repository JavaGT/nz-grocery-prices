# perf-trial 2026-09-09 — Subagent A ("lib") report

Branch `perf-trial-2026-09-09T085133-lib` (worktree), baseline `fcfed0e`.
Scope: library layer CPU/RAM + projection DB storage. All measurements on the
real archive `/Users/server/Development/nz-grocery-prices/data/prices.jsonl`
(12.0 MB, 18,726 records, 9,428 observations), Node v26.7.0, same commands as
the coordinator's baseline. Throwaway artifacts in `/tmp/lib-perf/` only; the
main checkout and sibling worktrees were never touched.

## Headline results

| Metric (coordinator's command) | Baseline | After | Delta |
|---|---|---|---|
| bench:archive loadMs | 284 (304 in brief) | **177–183** (3 runs) | **−36%** |
| bench:archive rssAfterLoadMB | 219 (223 in brief) | **165–169** (3 runs) | **−50–54 MB (−24%)** |
| calculateSales ms/pass | 4–6 | 3–7 (3 runs) | unchanged (noise) |
| build-db wall time | ~0.31 s | 0.283 s | unchanged (noise) |
| build-db size | 16,760,832 B | 16,760,832 B, same fingerprint | byte-identical |
| npm test | 3.6 s green | 3.48 s, 1014/1014 pass | green |
| npm run check | green | green | — |

Instrumented breakdown (own script `/tmp/lib-perf/profile-mem.mjs`, `--expose-gc`,
gc before measuring):

| Phase | Baseline | After |
|---|---|---|
| index-only load (`stats()` path): time | 167 ms | 120 ms |
| index-only load: RSS / live heap | 177.5 MB / 37.6 MB | 129.1 MB / 27.4 MB |
| full query({}): time | 104 ms | 58 ms |
| materialized 9,428 observations (live heap) | ~24.5 MB | ~23.8 MB |

Key insight from profiling: the 223 MB was NOT the index (only ~38 MB live)
nor the materialized observations (~25 MB). It was transient garbage —
per-record `structuredClone` at load, a second full deep-clone pass in
`filterObservations` after query materialization, and the loader holding every
line of the file in memory before decoding. `--cpu-prof` attributed ~105 ms of
319 ms to `structuredClone` plus 32 ms of GC serving it.

## Changes

### Commit 08fc98a — perf(lib): cut load/query clones and stream archive decode

1. **`src/archive-index.js` — `ArchiveIndex.query()` single materialization.**
   Before: materialized every candidate observation (5 `structuredClone`s
   each), then handed the whole array to `filterObservations`, which
   filtered/sorted and `structuredClone`d every observation AGAIN (a 6th deep
   clone per returned row; filtered-out rows paid full materialization then
   got discarded). After: envelope filters (`productId`/`storeId`/time, then
   `retailer` on the display-time store revision — GROK-7 semantics kept) run
   on raw records before any cloning; each surviving row is built exactly
   once from fresh clones; stable observedAt sort via decorate-sort-undecorate
   (each timestamp parsed once). Output proven byte-identical (see parity
   below).

2. **`src/archive-index.js` — `applyParsed(record)` loader fast path.**
   Records decoded from JSON.parse inside the loader are exclusively owned, so
   indexing them needs no defensive deep clone. Public `apply()` and
   `applyAdditions()` keep their copy-on-apply contract (pinned by
   test/archive-index.test.js "protects applied records from mutation").
   `applyParsed` documents the ownership requirement. Applies to the load
   path and to compaction re-index (records exclusively owned after
   `#resetState()`). Side effect: retained records keep their JSON.parse-native
   shape, which alone cut live index heap 37.6 → 27.4 MB.

3. **`src/repository.js` — streamed archive load.** `#loadUncached` now
   decodes + applies each line as a new module-level async generator
   `iterateArchiveLines()` yields it, instead of `readArchiveLines()`
   accumulating every `{line, terminated}` of the whole file before the first
   decode. Same manual "\n" chunk-boundary split, same line numbering, same
   torn-tail / legacy-refusal / defect-collection / `endsWithNewline`
   semantics. `readArchiveLines` + the two statics stay untouched because
   `scripts/repair-archive.js` and `scripts/migrate-v1-archive.js` (not my
   files) call them.

4. **`src/archive-index.js` — `eventTime()` memoized** in a module-level
   `WeakMap` (records are immutable once applied — documented invariant), so
   `insertChronologically`, `listingStateAt`, `revisionAt`, `stats()` and
   query stop re-running `Date.parse` on the same ISO strings.

### Commit(s) — DB storage investigation (no schema change landed; see below)

## Behavior-preservation evidence

- **Parity run vs baseline `fcfed0e`**: extracted the baseline `src/` tree
  (`git archive fcfed0e src`) and ran both versions over the real archive:
  `query({})` (9,428 obs), retailer+window-filtered query, per-product query,
  `stats()`, `productHistory`, `calculateSales`, plus
  `MemoryObservationRepository` append/dedup/query/history. Serialized
  outputs are **byte-identical** (9,850,387-byte JSON diff clean).
  (`/tmp/lib-perf/parity.mjs`.)
- Targeted: `node --test test/archive-index.test.js test/repository-writer.test.js
  test/repository-load.test.js test/analytics.test.js` → 79 pass.
  `node --test test/sqlite/*.test.js` → 118 pass (incl. deal-materialization
  parity — analytics reuse untouched; the coordinator's `test/sqlite/`
  trailing-slash form doesn't resolve on Node 26.7, glob used instead).
- Full `npm test`: 1014/1014 pass, 3.48 s. `npm run check`: clean.
- Hard rules honored: no FTS5, two-DB guard untouched, deal-materialization
  untouched, matching untouched, no fuzzy-match semantics touched, no live
  network commands, no writes near any real `data/` directory.

## Deliberately NOT done (with reasons)

- **Projection DB schema changes** (16.76 MB vs 12 MB archive, ratio 1.33×):
  measured where the bytes go first — text payloads ≈ 10.0 MB
  (product_revisions.data 4.18 MB, offer_revisions 3.83 MB, products 1.50 MB,
  snapshots 0.53 MB), the remaining ≈ 6.7 MB is indexes + page overhead.
  - `PRAGMA page_size` sweep by rebuild: 4096 → 17.23 MB, **8192 → 16.76 MB**,
    16384 → 16.96 MB, 32768 → 17.47 MB. Current setting already optimal.
  - Per-index drop+VACUUM probes: every index costs only 0.50–0.93 MB and each
    is load-bearing (schema comments cite EXPLAIN-verified query wins, e.g.
    `idx_or_observed` keeps cold /api/deals flat, `idx_products_updated`
    serves browse order). Dropping any trades read performance for <1 MB —
    rejected.
  - Bigger surgery (normalize `source_data`/`promotion_data` out of
    `offer_revisions`, store hashes as 32-byte BLOBs instead of 64-char hex,
    shrink the `UNIQUE(offer_key, observed_at, rev_hash)` dedup constraint)
    would each need new migrations + query changes for an estimated 1–3 MB
    total. The DB is a rebuildable denormalized projection; duplication is its
    job. Rejected as risk-dominant. Rebuild time (0.28 s) already fine.
- **Interning repeated strings** (productId/storeId/offerId/adapter across
  records): est. 1–2 MB at this scale; not worth the complexity now.
- **Skipping the second envelope validation on the load path**
  (`classifyParsedRecord` validates, then `#validateRecord` re-checks the
  envelope before the payload checks): ~2–4 ms of 120 ms; rejected — the
  branch complexity and the risk of diverging validation between entry points
  outweigh it.
- **Sharing product/store objects between returned observations** (identical
  revision payloads recur): rejected — callers may mutate query outputs; the
  documented contract is that results are independent of index state.
- **`MemoryObservationRepository.append` clone**: kept — semantically
  required (caller may mutate observations after append).
- **`calculateSales` micro-optimization**: 3–7 ms/pass is not a bottleneck;
  left alone.
- `docs/agent/*` updates: not needed — no command, structure, ownership, env
  or verification-path changes (and docs/agent is read-only reference for
  this lane). `tools/bench-archive.js` untouched per instructions.

## Trade-offs accepted

- `applyParsed` is a new method on `ArchiveIndex` whose safety depends on the
  documented exclusive-ownership requirement; misuse would alias caller state
  into the index. Mitigated by a loud doc comment and by keeping the cloning
  `apply()` as the default for any caller that retains a reference.
- The eventTime WeakMap assumes records are never mutated after apply — an
  invariant the class already documents and relies on elsewhere (draft()
  sharing).
- Streaming load duplicates ~15 lines of chunk-splitting logic with
  `readArchiveLines` (kept for the repair/migrate CLIs); both are marked as
  twins in comments.
- decorate-sort-undecorate in query allocates two intermediate arrays per
  query; measured net win vs O(n log n) `Date.parse` inside the comparator.

## Environment notes for re-runs

- `node --test test/sqlite/` (trailing slash) fails as MODULE_NOT_FOUND on
  Node v26.7.0; use `node --test test/sqlite/*.test.js`.
- RSS numbers wobble ±4 MB run to run; ranges above are 3-run spreads.
