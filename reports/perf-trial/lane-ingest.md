# Lane A2 — Projection rebuild (ingest) performance

Branch: `perf-trial-20260906-0839-ingest` — commit `47413f9`
Worktree: `/Users/server/Development/perf-trial-20260906-0839-ingest`

## Result

| Archive | Records | Before (median, 3x) | After (median, 5x) | Speedup |
|---|---|---|---|---|
| `data/prices.jsonl` (12.6 MB) | 18,726 | **1.88 s** (1.90/1.88/1.88) | **0.25 s** (0.32/0.25/0.24/0.25/0.26) | **~7.5x** |
| `data/breadth-pilot-nw.jsonl` (22.9 MB) | 35,039 | **3.87 s** (3.87/4.43/3.85) | **0.45 s** (0.48/0.82/0.45/0.44/0.44) | **~8.6x** |

Output sizes unchanged: 16,408,576 bytes (archive) and 30,375,936 bytes (NW).

## Profiling evidence

`node --cpu-prof` on the 18,726-record rebuild (~1.93 s wall):

| Self time | Function |
|---|---|
| 54% | `#insertProduct` |
| 33% | `#insertOffer` |
| 2.6% | `#ensureRetailer` |
| 1.8% | snapshot offer-reference SELECT loop |
| 0.8% | sha256 fingerprint |
| 0.5% | `readFileUtf8` + JSON.parse + classify |

The callee breakdown showed the hot time is self-time inside the insert
bodies: per-record `db.prepare()` calls (~100k SQL compiles per rebuild:
4-6 statements x every record) and per-statement autocommit journaling
(each INSERT/UPSERT/SELECT-then-write ran its own WAL commit).

## Changes (`src/sqlite/projection-repository.js`, rebuild path only)

1. **Reused prepared statements.** New module-level
   `prepareRebuildStatements(db)` prepares the 13 rebuild statements once
   per rebuild; the `#insert*` helpers now take the bundle. Statement SQL
   is unchanged, so the rows produced are identical.
2. **One transaction for the insert phase.** The four dependency-first
   insert loops (products → stores → offers → snapshots) now run inside a
   single `BEGIN IMMEDIATE … COMMIT`, rollback on error. Safe because the
   temp DB is throwaway: failure paths already discarded it unpublished.
   Migrations keep their own per-file transactions (unchanged), so the
   transaction starts after `applyProjectionMigrations` + the
   `import_runs` insert.
3. **`PRAGMA synchronous=OFF` on the temp connection only.** Per-connection
   setting, never persisted to the published file. The JSONL is the source
   of truth and publish is an atomic rename, so the throwaway temp DB
   loses nothing that matters. Authoritative JSONL writer fsync semantics
   untouched.
4. **`lastInsertRowid` from the INSERT result** instead of a second
   `SELECT last_insert_rowid()` query per store record (same value node:sqlite
   returns from `run()`).

Rejected (and why):
- **Batching offer-reference snapshot validation into a temp table** — the
  SELECT loop was 1.8% pre-fix and is now sub-noise with a reused statement;
  extra complexity for nothing measurable.
- **Changing `journal_mode` away from WAL** — WAL is persisted in the DB
  header; switching would alter published-file format. Kept WAL.
- **Statement caching across rebuilds / module-level cache** — statements
  bind to a connection; per-rebuild bundles are the correct lifetime.
- **`cache_size` bump** — not needed once transaction + statement reuse
  landed; numbers below were hit without it (smallest-change rule).

## Content-identity evidence

`tools/compare-db-content.js` (moved out of `test/` in review: node --test executes every file under test/ and this is a CLI tool, not a test) compares row counts for
all 9 tables, integer aggregates (SUM of price columns, observed_at, data
lengths), `_meta` (minus `built_at`/`jsonl_path`, which vary per run),
`sqlite_master` schema, and `import_runs` outcome — using `readBigInts` to
avoid JS number overflow:

```
IDENTICAL: data/before-archive.db === data/after-archive.db
IDENTICAL: data/before-nw.db === data/after-nw.db
```

BEFORE DBs were built with pre-change code and kept at `data/before-*.db`
in the worktree. Additionally `cmp` shows the only byte difference between
before/after files is `_meta.built_at` (wall-clock; two runs of identical
code differ the same way).

Two-DB rule: rebuild still only ever opens the temp projection DB;
`assertProjectionDbPath` guard untouched. No FTS5, no schema/index changes
(index lane owns those).

## Verification

- `npm run check` — pass.
- `node --test test/sqlite/*.test.js` — 116 pass, 0 fail.
- `npm test` (full) — 906 pass, 0 fail.
- Skip path (`status: "skipped"`, fingerprint match, no `--force`) re-checked.
- No live retailer commands run; archives copied read-only from the main
  checkout into the worktree `data/`.

## Trade-offs

- `synchronous=OFF` on the temp DB: a crash mid-rebuild can leave a corrupt
  temp file — it was already discarded unpublished, so no real exposure.
- Single transaction holds the write lock for the whole insert phase on the
  temp DB only; the `.lock` mkdir lock already serialized rebuilds.
- `built_at` granularity unchanged; the report/tooling outside owned paths
  untouched.
