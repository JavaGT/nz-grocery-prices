# SPA/server-perf trial — subagent "spa" report

Branch `perf-trial-2026-09-09T100601-spa`, baseline `deb5e9f`.
Commits: `2796323` (bench scripts + baseline samples), `769637c`
(search single-scan + statement memos + dialog leak fix + SPA dead-import
trim), `fc15d78` (comment tighten + after samples), `parity sweep commit`
(`perf-notes/parity-products-search.js`).

Fixtures: `/tmp/perf-spa/{prices.db,app.db}` rebuilt by
`perf-notes/seed-spa-fixtures.js` from the real `data/prices.jsonl`
(8,916 products / 9,428 offer revisions / 5 contexts / `deal_signals` empty
— same universe as the ui-lane trial). One seeded user + session + watch
list + saved searches, so every authenticated endpoint is benched for real.
Benches (all committed): `perf-notes/bench-spa.js` (HTTP, child-process
boot, browser headers, anon + sid-cookie paths), `bench-spa-micro.js`
(in-process attribution), `bench-spa-boot.js` (boot composition),
`parity-products-search.js` (behavior sweep). JSON samples in
`perf-notes/samples/spa-{baseline,after}-*.json`, `spa-micro-after.json`.
Noise: HTTP p50 ±0.05 ms, so sub-0.1 ms HTTP deltas are read from the
in-process micro numbers, not claimed from HTTP.

## Profile findings (measured first)

| cost | µs/op (in-process) | note |
|---|---:|---|
| search COUNT LIKE scan | ~520–550 | full covering-index scan of 8,916 names per query |
| search page LIKE scan + sort | ~660–740 | full table scan + temp B-tree |
| **search total (2 queries)** | **~1,210–1,290** | the only algorithmic outlier left server-side |
| search total (1 windowed query) | ~770–830 | the fix below |
| `prepare()` alone | 2.3–2.5 | statement reuse buys only µs except on tiny queries |
| session join lookup (re-prepare) | 9.7 | prepare is ~2/3 of it |
| session lookup (cached stmt) | 3.8 | |
| `_meta` read | 5.5 | per JSON response |
| route double-pass vs single-pass | 0.5 vs 0.2 | nothing |
| deals `loadUserTiers` reads | 23.3 (12.8 cached) | per authed deals request |
| cold boot spawn→healthy | 16.6–18.9 ms | bare `node` spawn ≈ 15 ms; app adds ~2 ms |

Notable negatives (evidence over instinct):
- **Cold boot is at the runtime floor.** Of ~17 ms spawn→healthy, ~15 ms is
  the Node runtime itself (`bench-spa-boot.js`: bare 14.9 ms vs full 15 ms);
  app-DB open+migrations ~1.7 ms, projection open + handlers + listen ~0–1 ms.
  Nothing landed; a smaller cold start is not available without changing runtime.
- **SPA payload/parse is not a lever.** JS is 47.3 KB raw / ~13.4 KB brotli;
  first V8 parse ~8.8 ms (desktop), and the deals-view dependency set already
  covers the graph (ui lane's no-split finding). Confirmed from the parse side.

## Changes

### 1. Filtered search runs one scan instead of two (`listProducts`)
`src/server/handlers/public.js`. When a WHERE clause exists (query and/or
retailer), the page query carries the total as `COUNT(*) OVER () AS _total`,
and the separate COUNT scan is gone. A page past the end (no rows → no window
value) falls back to the standalone count so `total` stays exact — pinned by
a new test. The unfiltered listing keeps the separate `COUNT(*)`: a window
over the whole table would force materializing every row before LIMIT, while
plain COUNT rides the covering name index.

- SQL per search: 1.21–1.29 ms → 0.77–0.83 ms (~35 % less SQL)
- HTTP p50 (40 reps): 2.16 / 1.83 → 1.70 / 1.70 ms; p95 2.89 / 2.37 → 1.96 / 2.08 ms
- Wire bytes unchanged (2,140 B br); `_total` never leaves the row mapper
- **Behavior parity:** `perf-notes/parity-products-search.js` runs the live
  handler vs the verbatim old two-query formulation over 23 query shapes
  (wildcards `% _ \\`, case, retailer combos, limit/offset incl. pages past
  the end) — all identical rows, order, totals. Order parity on the real DB
  verified separately for 5 queries before implementing.

### 2. Prepared-statement reuse on the hottest per-request reads
- `AppDatabase.getSession` (`src/sqlite/app-db.js`): every authenticated
  request resolves its session; a memoized prepared statement takes the
  lookup from 9.7 → 2.7 µs measured (prepare dominated this tiny query).
  Same pattern already used for match-pair statements in the same class.
- `Server.#projMeta` (`src/server/server.js`): one `_meta` statement per
  server instead of re-prepare per JSON response (~2.5 µs each). The
  projection connection is read-only; schema never changes at runtime.
- Trade-off: none semantic — statements live on the same connection the
  code already used. Not extended to `getWatchList`/`getStorePreferences`
  (deals-only, ~10 µs/request) — churn not justified; recorded below.

### 3. Detail-dialog keydown listener leak (SPA memory)
`public/components/detail-dialog.js` attached a document `keydown` listener
per open that removed itself only when it actually fired on Escape. Closing
via the close button, overlay, or click-outside leaked one document listener
plus the removed dialog's DOM tree per open — unbounded growth over a browse
session (each Escape keystroke also re-ran every stale handler). The listener
is now torn down in the existing `close` handler, covering every close path.
Escape behavior unchanged (native `<dialog>` Esc handling is the primary
path; the listener is belt-and-braces, now leak-free).

### 4. SPA dead code / bytes
Removed imports nothing used (`views/deals.js` whole format import,
`views/browse.js` whole format import, `views/watchlist.js` trimmed) and dead
exports `delegate`/`frag` in `utils/dom.js` (no importer anywhere, incl.
tests — "build it or delete it"). Net across the 13-file SPA:
67,889 → 67,577 B raw, 17,598 → 17,566 B brotli. The dialog fix's explanatory
comment adds +161 B br to detail-dialog.js; kept because the leak's history
is exactly what the comment must prevent regressing.

## Headline before/after

| metric | before | after |
|---|---:|---:|
| `/api/products?query=…` p50 | 2.16 / 1.83 ms | 1.70 / 1.70 ms |
| `/api/products?query=…` p95 | 2.89 / 2.37 ms | 1.96 / 2.08 ms |
| search SQL (in-process) | 1.21–1.29 ms | 0.77–0.83 ms |
| session lookup | 9.7 µs | 2.7 µs |
| cold boot | 16.6–18.9 ms | unchanged (runtime floor) |
| authenticated endpoints p50 | 0.12–0.25 ms | unchanged (≤ noise) |
| SPA wire (br) | 17,598 B | 17,566 B (leak-fix comment included) |

## Chose NOT to do (with reasons)

- **In-memory mirror of the products listing** (suggestions-index style):
  would cut another ~0.6 ms/query but must mirror `LIKE` wildcard semantics,
  the CASE ordering, and SQLite's unspecified tie order across plans — real
  drift risk for ~3–5 MB resident. Needs its own trial with an order-parity
  proof if search latency ever matters more.
- **Route-matching single pass** (0.5 → 0.2 µs): measured; churn not justified.
- **Statement memo for `getWatchList`/`getStorePreferences`** (~10 µs,
  authed-deals only) and **rate-limit cleanup DELETE-per-login**: real but
  µs-scale; left for a lane that owns login-path work.
- **Session memoization cache**: changes logout/expiry semantics (staleness
  window); scrypt never appears on hot paths (login only, rate-limited
  20/min, async as required) — nothing to fix there.
- **Session-cookie caching, zstd, MIN_COMPRESS lowering, API Cache-Control**:
  ui lane's rejections stand, re-derived.

## Found on the way (NOT fixed — coordinator tickets)

- **BUG (needs owner decision, functional not perf):** `public/views/settings.js`
  `renderSettings` defines `render()` but never calls it — the Settings view,
  which is also the only sign-in surface (401 → `#settings`), renders an empty
  container. Present on main (`deb5e9f`), identical in the shared checkout.
  One-line fix (call `render()`), but it is a behavior change outside this
  behavior-preserving trial.
- Covering-index idea for the search page query (schema owner's territory):
  the page scan reads 11 columns; a schema-side index/design change could
  shrink it further, but schema is not mine to touch.
- `views/browse.js` attaches a no-op `onInput` attr listener alongside the
  real debounced one; `api.js` double-`structuredClone`s cached GETs on
  write+read. Both µs-scale per view switch.

## Needs Safari verification (coordinator)

- Dialog open/close still behaves: Esc, close button, overlay click,
  "View price history" round-trip (listener teardown is not DOM-testable in
  `node:test` here; logic reviewed, syntax-checked, behavior designed
  unchanged).
- Views still render/import cleanly after the import trims (module graph is
  unchanged — `format.js` is still loaded via card/detail-dialog/saved/
  watchlist and preloaded by index.html, pinned by
  `test/frontend/index-preloads.test.js`).

## Verification

- `npm run check` — clean.
- Targeted: `test/server/ + test/app/` 207 pass; `test/frontend/` 49 pass;
  `test/sqlite/app-db.test.js` 30 pass; public/ `node --check` clean
  (public/ is not covered by `npm run check`).
- Full `npm test` — **1,024 tests, 0 failures** (~3–4.4 s).
- Parity sweep: 23/23 query shapes identical to the old formulation.
- Worktree clean; bench child processes shut down (one stray from a crashed
  early bench run found and killed; fixtures live only in /tmp).
