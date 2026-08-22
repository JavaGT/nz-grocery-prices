# CORE-6 — Legacy cutover

## Summary
Remove legacy paths per owner direction ("no hangups on legacy"): delete the
deprecated dashboard, remove v1 record support from the hot load path behind a
staged cutover [SOL-12].

## Staged sequence (in order)
1. Land idempotent `scripts/migrate-v1-archive.js`: detects v1 lines, reports
   v1/v2/invalid counts in dry-run mode, emits v2 records via normal ingest,
   rewrites via the CORE-2 writer protocol (backup → temp+rename under lock).
   Safe no-op when no v1 lines exist; second run reports zero changes without
   rewriting.
2. Dry-run against live archive (known state: 18,726 records, 0 v1 — expect
   zero-change report).
3. Remove v1 ingestion branch from `JsonlObservationRepository.#load()`; any
   future v1 line = clear "run migrate-v1-archive first" error.
4. Delete `dashboard/` + `test/server.test.js`; remove `dashboard` npm script;
   update all docs referencing it.
5. DECISIONLOG entry recording the override of the earlier preservation stance
   (owner direction 2026-08-23).

## Constraints
- Two-DB rule untouched. Collectors untouched. Migrator preserves mixed
  v1/v2 line order and derives change-only records against preceding state.

## Additional requirements from hostile review [GROK-3, GROK-10]
- v1 detection MUST use the shape predicate (`product && store && price &&
  source`, no `version` field) — v1 lines are unversioned; any `"version":1`
  string search is a guaranteed false negative.
- **Projection rebuild is in scope:** `src/sqlite/projection-repository.js`
  rebuild (~lines 105-128) whole-file-reads, accepts v1, and counts v1 as
  imported without inserting. Put it on the same decode path / reject v1 the
  same way BEFORE flipping `#load()`.
- After branch removal: `npm run compact` must refuse a v1-tainted file with
  "run migrate-v1-archive" instead of silently changing meaning.
- Before deleting `test/server.test.js`: port its `/api/feed`, `limit`, and
  agentFeed coverage onto PriceArchive-level tests (they exist nowhere else).
- Update ADR 0001 (claims legacy JSONL readable + compact rewrites to v2).

## Tests
Migrator round-trip on synthetic mixed v1/v2 fixture (temp dir): counts,
order preservation, idempotence (second run = no-op), backup creation;
post-cutover loader rejects v1 with actionable error.

## Verification
`npm run check` → `node --test test/local-archive-runner.test.js test/app/`
→ `npm test`.

## Blocked by
CORE-2 (migrator uses its writer protocol + lock).
