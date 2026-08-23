# CORE-3 — Indexed query engine

> **Status: COMPLETE + REVIEWED (2026-08-23).** Commits
> `c0a6df7` (ArchiveIndex extraction) and `8fd3fc7` (parity fixture, stats,
> performance smoke). `src/repository.js` shrank 1017 → 707 lines. The
> deterministic pre/post harness proved byte-identical results across 12
> queries covering revisions, snapshots, retailer changes, out-of-order
> records, equal timestamps, and product history. Full suite: 592/592.
> `56254ff` and `11b4f5d` close the hostile-review blockers: chronological
> revisions/snapshots, offer-hash dedup across non-latest revisions, candidate
> intersection, apply validation/atomicity, and mutation isolation.
> `fe836d3` closes the final concerns: late snapshotScope batches are rejected
> before persistence (later deltas cannot be rewritten safely), mixed-time
> batches use their latest timestamp, snapshot hashes use historical offer
> revisions, and historical queries do not fall back to future metadata.
> `9ddb0e8` adds temporal anchors for backfilled same-hash revisions, rejects
> snapshots whose offers have no revision at the snapshot time, removes the
> unused latest-offer cache, and preserves anchors through compaction. Full
> suite: **597/597**.

## Summary
Extract in-memory indexing + observation materialization out of
`JsonlObservationRepository` into `src/archive-index.js` as **ArchiveIndex**
(no filesystem knowledge): `apply(record)`, `query()`, `productHistory()`,
`stats()` [SOL-6]. The repository keeps load/lock/append/compact + wiring.

## Scope
- Indexes built during load and maintained by `apply`: offers by productId,
  by storeId, global time order; product/store revision maps.
- Ordering invariant [SOL-7]: per-entity revisions sorted chronologically at
  load AND apply (appends may arrive out of order); stable tie-break by
  insertion sequence. Tests for out-of-order records and equal timestamps.
- Query picks narrowest candidate set: productId+storeId → offer identity;
  productId → product index; storeId → store index; neither → chronological
  scan. Retailer filtering post-materialization (historical store revision
  determines retailer, not latest).
- `stats()`: record counts by type, retailers, date range.

## Constraints
- No FTS5. Projection DB untouched. JSONL layer only.
- `repository.js` must shrink, not grow — index lives in its own file with no
  FS imports.

## Tests
Parity suite (current scan behavior vs ArchiveIndex on 20k+ synthetic offers,
including out-of-order appends); point-query performance (<50ms on 20k);
stats correctness; historical-store-revision retailer filtering.

## Verification
`npm run check` → `node --test test/repository.test.js test/archive-index.test.js`
→ `npm test`.

## Blocked by
CORE-2 (owns repository.js first; sequential handoff avoids collisions).
