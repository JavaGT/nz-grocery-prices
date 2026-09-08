# perf-trial 2026-09-09 — ingest lane report

Branch `perf-trial-2026-09-09T100601-ingest` (worktree), baseline `deb5e9f`.
Scope: ingest/storage — `src/archive-records.js`, `src/repository.js`,
`src/archive-index.js` append-path (see ownership note below), `src/domain/`,
adapter/`retailers/_lib` parse CPU, `scripts/compact-archive.js`.

Node v26.7.0. All benches offline against copies of the real archives
(`data/prices.jsonl` 12.6 MB / 18,726 records; `data/breadth-pilot.jsonl`
18.3 MB / 28,764 records). The shared checkout and every real `data/` file
were only ever read; scratch space was `/tmp/ingest-perf/`. No live network
commands were run.

## Profile findings (baseline, `--cpu-prof` over the bench, 3,546 ms sampled)

| Hotspot | Self time | Share | Root cause |
|---|---|---|---|
| `structuredClone` (plan + apply clones) | ~665 ms | 19% | every planned record deep-copied product/store/price/promotion/source via `structuredClone`; `apply()`/`applyAdditions()` cloned each record again |
| `stable()` | ~460 ms | 13% | `localeCompare(key, "en")` per key per object per hash, plus a full canonical object rebuild |
| GC | 410 ms | 12% | allocations of the above two |
| `fingerprint` (sha + wrapper) | ~220 ms | 6% | `JSON.stringify(stable(v))` + sha256 per payload |
| `decodeArchiveLine` | ~158 ms | 4.5% | `JSON.parse` of every line (irreducible) |
| `encodeRecord` | ~152 ms | 4% | `JSON.stringify` per record (irreducible; already native-fast) |
| `utf8Write` | ~91 ms | 3% | Buffer encoding of archive bytes |

`fingerprint()` runs on every product/store/offer record at load (hash
re-verification: 18.7k–28.8k per archive) and 3x per observation in append
planning — so it is the hottest pure function in the ingest path.

## Changes (3 commits)

### `a5a814d` — canonical key-order memo + direct canonical JSON serializer

`src/archive-records.js`:

1. `sortedKeyOrder()` memo: the locale-pinned key sort runs once per distinct
   key sequence instead of once per object instance. Signature is
   `JSON.stringify(keys)` (injective — a NUL-bearing key can never alias
   another sequence), cache bounded at 8,192 entries with per-call fallback.
   Equivalence to the previous filter-then-sort: object keys are unique and
   filtering preserves relative order, so walking the fully sorted order and
   skipping `undefined` values yields the identical sequence.
2. `fingerprint()` now serializes directly (`canonicalJson()`) to exactly the
   bytes of `JSON.stringify(stable(value))` without building the intermediate
   object. Reproduces every quirk: integer-like keys emit in ascending
   numeric order FIRST (that is the order `Object.fromEntries` produces, and
   the reference output follows the rebuilt object's own key order, not the
   locale sort), then locale-sorted string keys; undefined values dropped;
   undefined array elements as `null`; `NaN`/`Infinity` as `null`; finite
   numbers as `ToString`; unescaped-string fast path; bigint/symbol/function
   delegate to `JSON.stringify` so error messages match exactly.
   `stable()` itself is unchanged (still exported, still pinned by
   `test/domain/fingerprint.test.js`).

### `9dff75a` — stream compact writes in ~1 MB chunks

`src/repository.js` `#compactLocked()`: was joining every encoded record into
one archive-sized string, then `Buffer.from`-ing it again (~2x archive size in
transient memory: 19 MB string + 19 MB buffer on a 19 MB archive). Now writes
~1 MB chunks — same bytes on disk (records joined `"\n"`, trailing `"\n"` when
non-empty), one `fh.sync()` at the end, temp + atomic rename + parent-dir
fsync unchanged. `writeAllAndSync` split into `writeAll` + sync so
`scripts/repair-archive.js` keeps its imported contract.

### `1f8c8ba` — `cloneJson()` for append-path payload copies

New `cloneJson()` in `src/archive-records.js`: recursive plain-JSON deep copy
that falls back to `structuredClone` for anything that is not an array or
plain object (class instances, Dates, Maps, null-prototype, cross-realm), so
it is exactly equivalent for every input except cycles (DataCloneError ->
stack overflow; both throw before anything persists). Holes, undefined
values, and integer-like key order are preserved. Swapped ONLY the
append/storage sites: `apply()`, `applyAdditions()`, the three `#plan*Record`
payload clones (`src/archive-index.js` — the profiling escape-hatch in my
brief; small and parity-proven) and `MemoryObservationRepository`
append/productHistory (`src/repository.js`). Query-materialization clones
were left untouched — lib-lane territory, caller-protection contract.

New test: `test/domain/fingerprint-serializer.test.js` (9 tests) pins the
serializer to `JSON.stringify(stable(...))` on every drift-prone shape.

## Before/after (in-process A/B vs baseline `deb5e9f`, alternating reps, median)

The authoritative numbers — baseline and current run interleaved in ONE
process, so machine noise from the parallel lanes cancels
(`perf-notes/evidence/ab-bench.mjs`, `ab-compact.mjs`):

| Metric | 12.6 MB prices | 18.3 MB breadth |
|---|---|---|
| cold load + hash verify | 91 → 87 ms (−4%) | 149 → 129 ms (**−13%**) |
| append 9,428 obs (all new, 18–28k records written) | 216 → 179 ms (**−17%**) | 455 → 322 ms (**−29%**) |
| append re-run (all dedup-rejected — the nightly no-op) | 96 → 71 ms (**−26%**) | 200 → 134 ms (**−33%**) |
| compact phase (after load) | 94 → 75 ms (**−20%**) | 159 → 125 ms (**−21%**) |
| compact peak RSS | — | 290 → 256 MB (−34 MB, doubled 37 MB archive) |

Cross-process bench runs (`perf-notes/bench-ingest.mjs`, noisier, same
direction): prices load 99→86, appendNew 267→~200, appendDup 101→~85,
compact 195→~170 ms; breadth load 170→~135, appendNew 512→~350,
appendDup 196→~150, compact 345→~260 ms.

### Adapter / `retailers/_lib` parse CPU (bench `perf-notes/bench-parse.mjs`)

CAVEAT: raw retailer payloads are not archived anywhere (archives hold
canonical records only; no HAR files exist), so payloads are
synthetic-but-realistic — the fixture shapes pinned by `test/retailers/*`
inflated to 48-item pages. Verdict, not optimization, is the deliverable:

| Family | µs/item | ms per 48-item page |
|---|---|---|
| sfcc grid + observations | 3.6 | 0.173 |
| html-grid tiles | 1.4 | 0.066 |
| estar window + map | 1.4 | 0.069 |
| jsonld-pdp parse + spec | 1.1 | 0.055 |
| shopify observations | 0.5 | 0.026 |
| algolia hits | 0.4 | 0.018 |
| next-data parse + map | 0.4 | 0.021 |
| woo / magento / constructor-io mappers | ≤0.1 | ≤0.005 |

Even the worst case (3.6 µs/item) puts a whole 500-retailer campaign night
(~1M items) at ~4 s CPU spread across the 60–70-minute network-bound walk.
Parse CPU is noise next to network latency; no adapter change was warranted.

## Behavior-preservation evidence (all vs baseline `deb5e9f`)

- **Fingerprint parity**: 47,500 checks — every payload in both real archives
  (47,455) plus 45 edge cases (NaN/±Infinity/−0/1e21, unicode + locale-tricky
  keys, escapes, empty keys, sparse arrays, Date objects, null-prototype,
  getter-invoked-exactly-once, BigInt error text) — identical sha256 digests,
  0 mismatches (`perf-notes/evidence/parity-fp.mjs`).
- **Compact byte parity**: output sha256 identical at both archive scales AND
  on a doubled 37 MB archive exercising the dedup path (37,452 → 28,154
  records, sha `6d39cfd3…`) — sizes and stdout identical
  (`evidence/compact-parity.mjs`).
- **Append byte parity**: appending the 9,428 real observations to a fresh
  archive produces byte-identical files baseline vs current, both as one
  batch and in 100-observation chunks (sha `756d34f7…`)
  (`evidence/append-parity.mjs`).
- **Query parity**: `query({})`, retailer-filtered, window-filtered,
  `stats()`, `productHistory()` outputs identical on both archives
  (`evidence/query-parity.mjs`).
- **Durability unchanged**: appends still fsync once per `append()` batch;
  compact still temp-file + single fsync + atomic rename + parent-dir fsync.
  No fsync was removed, batched across calls, or weakened. The only
  durability-adjacent change is intra-call chunking of compact writes with
  the sync still after ALL bytes.
- `npm run check` clean; full `npm test` **1,032/1,032 pass** (1,020 baseline
  + 12 new). Targeted: archive/repository/domain/analytics 122 pass.

## Trade-offs accepted

- `sortedKeyOrder` memo adds module state (bounded 8,192 entries, small
  arrays); past the limit it degrades gracefully to per-call sorting.
- `canonicalJson` duplicates the canonical-format rules that `stable()`
  embodies; the new test file pins both to the same digests, and the
  integer-like-key quirk (reference emits object-order, not locale-order)
  is now documented in code — it was previously implicit.
- `cloneJson` turns a cyclic input's failure from `DataCloneError` into a
  stack overflow. Both throw before anything is persisted; observations are
  JSON-shaped by contract (they are JSON-encoded immediately after), and the
  exact-equivalence fallback keeps every non-plain-JSON value on the old path.
- Commit `1f8c8ba` touches `src/archive-index.js` (6 mechanical call-site
  swaps + 1 import). Per the brief this needed to be "small and
  parity-proven": 6 lines, proven by append/query/compact byte parity plus
  the full suite.

## Rejected (with evidence)

- **Adapter parse micro-optimizations** (`html-grid` compiles
  `anchorTag`/`attribute` regexes per call; `decodeEntities` runs 15 replace
  passes): measured 0.4–3.6 µs/item — seconds per campaign night vs an hour
  of network time. Immaterial.
- **JSON round-trip clone** (`JSON.parse(JSON.stringify(x))`) instead of
  `cloneJson`: drops undefined-valued keys that `structuredClone` keeps, and
  would silently reshape records that later flow into `encodeRecord`.
- **Memoizing fingerprints in a WeakMap**: load verifies each stored hash
  exactly once per record and planning hashes each new payload exactly once —
  there is no repeat-hashing pattern to memoize.
- **fsync batching / weakening durability**: explicitly rejected — no
  measurable win at real batch sizes and it trades away the archive's core
  guarantee.
- **`encodeRecord` fast serializer**: records stringify with native
  `JSON.stringify` (~1.7 µs/record, insertion-order keys — canonical
  re-sorting would CHANGE output bytes). Nothing to win.

## Opportunities observed, NOT taken (for the coordinator to ticket)

1. **Query-materialization clones could also use `cloneJson`**
   (`src/archive-index.js` lines 39, 125, 420, 486–496): same exactness
   argument as the append path; helps `query()`/`productHistory()` (lib-lane
   surface, declared done by the prior report — I left it alone). Est. a few
   percent of query latency at 9.4k-row scale.
2. **`decodeArchiveLine` self time 141 ms (~4.5%)** is mostly `JSON.parse` of
   ~600-byte lines — a custom line parser could beat it but is high-risk
   micro-territory for a 4% win.
3. **`MemoryObservationRepository` `observationKey`** builds
   `JSON.stringify(observation.price)` per observation per append — test-seam
   hot path only, immaterial at production scale.

## docs/agent updates

None needed: no commands, ownership, env vars, or verification paths changed
(benches live under `perf-notes/`, tests are glob-discovered).
