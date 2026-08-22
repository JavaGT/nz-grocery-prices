# CORE-3 — Indexed query engine

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
