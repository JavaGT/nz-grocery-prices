# CORE-2 — Archive durability

> **Status: COMPLETE + REVIEWED + FIXED (2026-08-23).**
> M1 `bd8ae37` canonical encoding · M2 `e16a39f` append validation ·
> M3 `6d679e4` writer protocol · M4 `cdb0b1e` tail-tolerant load ·
> M5 `38ed1d5` repair CLI + publisher alignment · M6 `9fee4ad` docs ·
> live-data bugfix `49f3ca7` (snapshots misjudged corrupt — caught only by
> probing real data) · hostile review (Grok 4.6): 4 blockers + concerns all
> dispositioned across `3d720b4`…`4c458b1` (short-write loops, repair under
> lock, load single-flight + failure reset, stale-lock pid reclaim,
> dirsync-on-create, CLI edges, accepted-design entries in DECISIONLOG).
> Final: **576/576**.

## Summary
Make the JSONL archive crash-safe end to end: fsync'd appends that never
mutate memory before persistence succeeds, an atomic-replace protocol for
compaction/repair/migration, stream-based tail-tolerant loading with hash
verification, and a repair CLI.

## Scope

### Writer protocol (single shared path for ALL mutations)
```
planAppend(observations, options) → records     # pure, NO in-memory mutation
acquire exclusive mkdir-based lock (<archive>.lock)
append encoded records via open-append → write → fh.sync()   (or temp+rename+dirsync for full rewrites)
release lock
only now apply(records) to in-memory state
```
- `compact()`, repair, migration use: temp file in same dir → sync → atomic
  rename over live file → parent-dir fsync — under the same lock. Never
  `writeFile` the live path.
- In-process append queue serializes concurrent `append()` calls.
- Document: readers on the old inode finish safely; tail-following unsupported.
- Also create `src/archive-records.js`: v2 record encoding/decoding +
  `productRevisionHash` / `storeRevisionHash` / `offerRevisionHash`, absorbing
  the `stable()`/`fingerprint()` helpers from repository.js (relocate
  `src/domain/fingerprint.js` here if it landed there — content identity is
  archive-format-internal, not domain [SOL-4]).

### Load protocol
- Stream via `node:readline`.
- Newline-terminated invalid line → hard error with line number (even if last).
- Unterminated final line → try JSON.parse: valid record = keep (crash between
  write and newline); invalid fragment = quarantine + continue.
- Before any append onto an archive with an invalid unterminated tail:
  truncate/quarantine under lock first. Never blind-append past it.
- Validate v2 record structure and verify stored hashes against recomputed
  canonical encodings during load [SOL-5].

### Repair CLI
- `scripts/repair-archive.js` + `npm run archive:repair`: scan, quarantine bad
  fragments to `<archive>.corrupt-<ts>`, atomically rewrite clean file, report
  counts. Uses the writer protocol.

## Constraints
- Never touches `app.db`. Zero dependencies. Tests use temp dirs only.
- Valid-archive behavior unchanged: same records, same hashes, byte-stable.

## Tests
- plan-append failure leaves memory untouched (inject throwing writer).
- Complete-but-unterminated final line is recovered as a record.
- Invalid unterminated fragment quarantined; subsequent append refuses until
  repaired/truncated.
- Mid-file corruption throws with line number.
- Repair round-trip: quarantine + rewrite + reload equals expected records.
- Hash mismatch detected at load.
- Compaction uses rename (assert no direct write to live inode — e.g. watcher
  on inode number).

## Verification
`npm run check` → `node --test test/archive.test.js` (+ any new
`test/repository*.test.js`) → `npm test`.

## Blocked by
CORE-1 (validation at append boundary; fingerprint relocation).
