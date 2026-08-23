# CORE-6 — Legacy cutover

> **Status: COMPLETE (2026-08-24).** All stages landed and hostile-reviewed
> (Luna round 2 blockers/concerns addressed). v1 is refused by every hot
> path; the dashboard is deleted; the migrator is the only v1 handler.

## Summary
Remove legacy paths per owner direction ("no hangups on legacy"): delete the
deprecated dashboard, remove v1 record support from the hot load path behind a
staged cutover [SOL-12].

## Staged sequence (all landed)
1. ✅ `scripts/migrate-v1-archive.js` (commit 4041bad, amended 9de16b5):
   shape-detected v1 (`isV1Record`), dry-run `{v1, v2, invalid, changes}`,
   derivation against ALL preceding state via `parseObservation` +
   `ArchiveIndex.planAppend`, mixed line order preserved, byte-exact fsynced
   backup before temp+rename rewrite under the shared `<archive>.lock`,
   quarantine-not-invent for undecodable lines, true no-op on no-v1 files.
2. ✅ Dry-run against live archive via temp copy: 18,726 records, 0 v1,
   0 invalid, copy byte-identical after run.
3. ✅ Repository refusal (43edc2e): `#load()` throws
   `Legacy v1 archive record at <file>:<line>; run node
   scripts/migrate-v1-archive.js --file <file> first`; compact inherits it;
   torn-tail + hash-defect behavior preserved; same/fresh-instance coverage.
4. ✅ Projection refusal + hardening (cb961ec): rebuild refuses v1 (mixed or
   v1-only) before publishing, via `classifyParsedRecord` (unknown types and
   malformed envelopes are per-line errors, never silently counted); fail-fast
   `<db>.lock` acquired before the JSONL read, owned-lock-only release,
   mtime+size re-validated under the lock before publish; two-DB guard
   refuses app.db/APP_DB/`*.app.db` outputs in rebuild + build-db.
5. ✅ Dashboard deletion (909823d): `dashboard/**`, `test/server.test.js`,
   `dashboard` npm script removed. Contract port: `/api/deals` tests already
   pinned composition/limit caps/dedup; `toAgentFeed`/`agentFeed` tests now
   pin item fields (`productId`, `retailer`, `currentCents`, `savePercent`),
   `generatedAt`, and NZD currency. No compatibility `/api/feed` endpoint.
6. ✅ Docs: README (legacy section rewritten, compact claim fixed), ADR 0001
   amended (readability claim corrected), DECISIONLOG override + staged
   decisions, implementation-spec contradiction annotated, docs/agent
   project-map/command-map/verification updated.

## Constraints (met)
- Two-DB rule untouched: rebuild never opens app.db; refuses app.db outputs.
- Collectors untouched. Migrator preserves mixed v1/v2 line order and derives
  change-only records against preceding state.
- No compatibility shim: v1 is handled only by the one-shot migrator.

## Tests
- `test/migrate-v1.test.js` (16): guards, dry-run immutability, mixed order +
  temporal anchors, quarantine, byte-exact backup (blank lines, missing final
  newline), idempotence, round-trip query equivalence vs the normal writer.
- `test/repository-load.test.js`: v1 refusal (same/fresh instance, compact,
  torn-tail/defect preservation).
- `test/sqlite/rebuild.test.js`: v1 rejection (mixed/v1-only), lock refusal
  leaves no rename + never removes another writer's lock, own-lock release on
  success AND failure, app.db output guards, unknown-type error counting.
- `test/sqlite/concurrency.test.js`: fail-fast lock semantics (winner
  publishes, losers refuse cleanly, DB valid).
- `test/analytics.test.js`: legacy feed item contract pinned on toAgentFeed.

## Verification
`npm run check` → `sh -n scripts/archive-daily-local.sh` → targeted
migration/projection/repository/analytics tests → `npm test` (full suite
green; final count recorded in the handoff report).
