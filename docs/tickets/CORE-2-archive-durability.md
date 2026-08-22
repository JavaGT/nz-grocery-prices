# CORE-2 — Archive durability

> **Status (2026-08-23):** IN PROGRESS — resumed same session after it died
> mid-flight. Committed: M1 `bd8ae37` (archive-records.js canonical encoding),
> M2 `e16a39f` (append-boundary validation). Uncommitted M3 work had broken
> 2 projection-equivalence tests; manager diagnosed, session resumed with
> reconciliation instructions. Remaining: M3 writer protocol, M4 load
> protocol, M5 repair CLI + publisher alignment, M6 docs.

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
