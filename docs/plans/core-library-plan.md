# Core Library Plan — `nz-grocery-prices`

Status: REVISED v3 — cross-checked by GPT 5.6 Sol [SOL-n] and Grok 4.6
[GROK-n]. All blocker-level findings folded in.
Date: 2026-08-23
Owner: Manager (this session)

## Premise

A local-first New Zealand grocery price archive:

```
retailer APIs ──adapters──▶ PriceObservation ──append-only JSONL (authoritative)
                                                        │
                                                        ▼ rebuild
                                              SQLite projection (prices.db)
                                                        │
                              app.db (user data) ───────┤
                                                        ▼
                                     price•minder app + agent feed
```

The **core** is everything below the HTTP layer. "No hangups on legacy":
the legacy dashboard and v1 record support in hot paths get removed; a one-shot
migrator tool remains as a safety utility.

## Current state (verified)

| Area | File | State |
|---|---|---|
| Record model | `src/repository.js` | v2 change-only records. Solid idea, zero validation, monolithic 434-line file mixing FS, encoding, indexing, query. |
| Durability | `src/repository.js` | `appendFile`, no fsync; memory mutated **before** persist [SOL-1]; `compact()` writes live file in place [SOL-3]. One bad line bricks `#load()`. |
| Loading | `src/repository.js` | Whole-file string read; queries scan all offer revisions. |
| Collector publisher | `scripts/archive-daily-local.sh` | Own `.collect.lock`; publishes via `cp` → stage → `mv -f`, **no fsync/dir-sync**, different lock name than any repo-side lock [GROK-2]. |
| Projection rebuild | `src/sqlite/projection-repository.js:105-128` | Whole-file read, accepts v1, counts v1 "imported" without inserting [GROK-3]. |
| Analytics | `src/analytics.js` | Assumes sorted group input; effective-price ignores promotion windows for sales baselines; duplicated policy logic [SOL-10, GROK-8]. |
| Hash helper | `stable()` | `localeCompare` with **no locale arg** — environment-dependent ordering for non-ASCII keys [GROK-4]. |
| Live archive | `data/prices.jsonl` | 18,726 records, 100% v2 (unversioned-shape v1 count = 0), newline-terminated, 12MB. Hashes match today's `stable()` on this machine [GROK-4]. |

## Goals

1. Validated domain model at the **repository.append boundary** — adapters keep
   their skip-on-incomplete (`undefined`) behavior so one malformed row can
   never abort a whole daily run under `set -eu` [GROK-9].
2. Durable archive: crash-safe writer protocol, honest APFS durability story,
   tail-tolerant loading, repair CLI.
3. `ArchiveIndex` extraction — clarity seam first, performance second
   [SOL-6, GROK-7].
4. Deterministic analytics with centralized price semantics; promotion-window
   evaluation treated as an explicit behavior change with before/after
   fixtures [GROK-8].
5. Small, honest public surface.
6. Legacy deleted behind a staged cutover that includes the projection
   rebuild parser [GROK-3].

## Non-goals

No new dependencies · no changes to collector **semantics** (the publisher
shell script's mechanical lock/fsync steps may change — see Writer Protocol)
· no FTS5 · no dual-write · rebuild paths never open `app.db` · no frontend.

## Module architecture

```
src/domain/observation.js    parseObservation / validateObservation — domain rules only
src/archive-records.js       SINGLE canonical encoding home: stable serialization
                             (locale-pinned), fingerprint, product/store/offer
                             revision hashes, v2 record encode/decode, v1 shape
                             predicate. NOT exported from package root [SOL-4].
                             Absorbs/deletes src/domain/fingerprint.js and the
                             copies in repository.js — exactly one implementation
                             may exist [GROK-5].
src/archive-index.js         ArchiveIndex: apply(record), query(), productHistory(),
                             stats() — no FS knowledge [SOL-6]
src/repository.js            JsonlObservationRepository: load, lock, append,
                             compact, wiring only
src/analytics.js             pure math; selectEffectivePrice shared;
                             buildPriceSeries(observations, {pricePolicy})
src/archive.js               PriceArchive: optional injected clock supplies
                             query.at [SOL-9]; no clock inside analytics
```

### Canonical serialization rules [GROK-4, GROK-5]

- One `stable()`/`fingerprint()` implementation, in `src/archive-records.js`.
- Key sort pinned: `a.localeCompare(b, "en")` — deterministic across
  environments. Verify pinned ordering reproduces existing live-archive hashes
  via fixture tests before switching `repository.js` over.
- Optional numeric cents accept `null` as absent (existing fixtures store
  `promoCents: null`) — validation leniency documented, not silent coercion.

### Writer protocol (single shared path; ALL mutators) [SOL-1..3, GROK-2, GROK-6, GROK-12]

One lock directory name shared by the repository AND
`scripts/archive-daily-local.sh` (rename its `.collect.lock` usage; mechanical
change only):

```
under lock:
  if archive mtime/inode/size changed since load → discard memory, reload   [GROK-12]
  planAppend(observations, options) → records        (pure, no mutation)
  append: open(path,'a') → write → fh.sync() → close                        [GROK-6]
          (appendFile returns no handle — specified explicitly)
          fsync parent dir on first-create of the archive
  full rewrite (compact/repair/migrate): temp file in same dir → fh.sync()
          → rename over live → parent-dir fsync
release lock → only now apply(records) to in-memory index
```

- Durability honesty [GROK-6]: Node `sync()` is `fsync(2)`, not APFS
  `F_FULLFSYNC` — this buys crash-atomicity + torn-tail recovery, **not**
  guaranteed power-loss durability. Documented in README + code comments.
- Readers on the old inode finish safely; tail-following unsupported.
- Repair/migrate CLIs: require explicit `--file <path>` (reject any `.db`),
  require `--force` to touch `data/prices.jsonl`, never default to the live
  path, quarantine destination fsync'd before the clean rewrite [GROK-11].

### Load protocol [SOL-2, GROK-1]

- Stream by reading chunks and splitting on `\n` manually (readline cannot
  report whether the final line was terminated); termination decided by last
  byte.
- Newline-terminated invalid line → hard error with line number (even if
  last line).
- Unterminated final line → try JSON.parse: valid record = recover it; invalid
  fragment = quarantine + continue.
- Appending onto an archive with an invalid unterminated tail: forbidden until
  repaired/truncated under lock.
- Load validates record **envelope** (version/type/id fields) and verifies the
  stored `hash` equals `fingerprint(record.data)` as stored. It does **NOT**
  run `parseObservation()` over historical payloads [GROK-4]. Snapshot
  `offersHash`: recomputed only in repair --verify mode, not every load.
- Hash mismatch → surfaced by loader as a quarantinable defect (repair CLI
  handles); not a hard load abort until the first successful full verify.

### Index invariants [SOL-7]

- Per-entity revisions chronologically sorted at load and apply; stable
  tie-break by insertion sequence.
- Narrowest candidate set wins: productId+storeId → offer identity; productId
  → index; storeId → index; neither → chronological scan. Retailer filtering
  post-materialization (historical store revision decides).

### Analytics semantics [SOL-8..10, GROK-7, GROK-8]

- `selectEffectivePrice(observation, { pricePolicy, at })`: sales baseline
  points evaluate promotion activity at their own `observedAt`; ongoing sales
  at query `at`; inclusive boundaries. **This changes `/api/deals` output** —
  ship with before/after golden fixtures, labeled a behavior fix.
- Sort each offer group internally; input order no longer trusted.
- `buildPriceSeries(observations, { pricePolicy })` pure; points
  `{ observedAt, cents, kind }`; grouped by offer (productId+storeId).
- Clock injection at PriceArchive only.

## Work breakdown

| Ticket | Owns | Key files |
|---|---|---|
| CORE-1 | domain observation validation; fingerprint relocates to archive-records.js | `src/domain/observation.js`, `src/archive-records.js`, check-glob fix |
| CORE-2 | writer/load protocols, repair CLI, shared collector lock, fsync spec | `src/repository.js`, `scripts/repair-archive.js`, `scripts/archive-daily-local.sh` (mechanical) |
| CORE-3 | ArchiveIndex extraction + parity corpus incl. snapshots/asOf/retailer-change | `src/archive-index.js` |
| CORE-4 | selectEffectivePrice, sorting fix, buildPriceSeries, /api/deals fixtures | `src/analytics.js`, `src/archive.js` |
| CORE-5 | root surface, shape-asserting type tests, README | `src/index.js`, `.d.ts` |
| CORE-6 | staged legacy cutover incl. projection rebuild parser + compact refusal + dashboard-test port | `dashboard/`, `scripts/migrate-v1-archive.js`, `src/sqlite/projection-repository.js` |

Order: CORE-1 → CORE-2 → CORE-3 → CORE-5; CORE-4 after CORE-1 (parallel);
CORE-6 staged after CORE-2. CORE-5 additionally after CORE-4.

## Verification discipline

Per ticket: `npm run check` → targeted tests → full `npm test`.
Required seams [GROK-14]: crash-restart visibility of appended records;
append-after-missing-newline does not glue records; lock dir cleaned up;
check-glob covers every new source dir; migrator round-trip test runs in
CORE-6 verification. Live collectors and `archive:local` are never verification.

## Risks & mitigations

- Locale-pinned sort changing hashes → proven byte-identical on live-derived
  fixtures before adoption; repair CLI as escape hatch.
- Parallel lanes colliding → strict per-ticket file ownership; repository.js
  sequential (CORE-2 then CORE-3).
- Publisher/append race → single shared lock + re-stat-under-lock reload.
