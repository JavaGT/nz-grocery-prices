# perf-trial 2026-09-09 — subagent "endurance" report

Branch `perf-trial-2026-09-09T100601-endurance` (worktree), baseline
`22c4da0` (trial HEAD, includes all previously landed lanes' work). Commits:
`fe0c14d` (SPA fixes + tests + bench + 3-min baselines), `7c2d335` (10-min
baseline + heap-prof dir fix). Node v26.7.0. Lens: **memory and steady-state
over time**, not single-request latency.

Fixtures: `/tmp/perf-endurance/{prices.db,app.db}` seeded by the committed
`perf-notes/seed-spa-fixtures.js` from the real `data/prices.jsonl`
(8,916 products, 5 contexts; app DB seeded with user + session + watch list +
saved searches so every authenticated endpoint is exercised for real). The
real `data/` DBs were never touched. No network collection; everything bound
127.0.0.1 ephemeral; no background processes left.

## Bench (committed, repeatable)

- `perf-notes/bench-endurance-server.js` — runs the **real** app server
  (`createAppServer`, env-pointed at the fixture DBs) in a child process
  started with `--expose-gc`. Samples `process.memoryUsage()` every 250 ms
  **right after `global.gc()`** (post-GC retained memory, so client-driver
  garbage never pollutes the numbers), plus 10 ms sampling through module
  load to capture the boot peak. Writes JSONL samples to disk; clean
  shutdown via stopfile/SIGTERM (DBs closed, exit 0 so `--heap-prof` flushes).
- `perf-notes/run-endurance.js` — driver. Mixed workload per 100 requests:
  20 product searches, 8 retailer-filtered searches, 10 product details,
  10 histories (200-point), 5 stores, 7 suggestions, 3 health, 12 deals
  (8 with rotating retailer), 14 authenticated reads (sid cookie:
  watch-list / preferred-stores / saved-searches / tiered deals), 5 static
  files, 1 favicon 404, 1 SPA nav fallback, plus a register+login+logout
  scrypt cycle every 1,500 requests. ~2,200 rps sequential (loopback).
  Reducer splits boot / warmup / load thirds and reports medians.

## Headline: the server is already at steady state (evidence)

3 × 3-min baseline runs (~400 k requests each) + one 10-min run
(**1,163,522 requests**, all statuses as designed):

| run | requests | boot peak | post-GC RSS thirds | growth | notes |
|---|---:|---:|---|---:|---|
| baseline-1 | 403,809 | 45.8 MB | 159.3 / 161.3 / 160.5 | +1.2 MB | |
| baseline-2 | 404,016 | 45.9 MB | 142.8 / 143.6 / 140.7 | −2.1 MB | |
| baseline-3 | 399,019 | 45.8 MB | 157.1 / 174.3 / 175.8 | +18.7 MB | warmup step mid-run |
| baseline-10min | 1,163,522 | 45.9 MB | 143.5 / 139.2 / 140.7 | **−2.9 MB** | authoritative |
| after-1 (reproducibility) | 378,700 | 46.0 MB | 141.8 / 142.2 / 140.7 | −1.0 MB | server code identical to baseline |

- Run 3's +18.7 MB is not a leak: the 10-min curve shows RSS climbing in
  ~15–20 MB V8 heap-growth steps during the first ~2 min, then **flat** for
  8+ minutes (oscillating 135–157 MB with GC; post-GC `heapUsed` stable at
  20–23 MB). The 3-min windows just cut at different points of that warmup.
- Post-GC `heapUsed` is only ~13–21 MB — retained JS is tiny; the ~140 MB
  RSS is V8 heap pages not returned to the OS plus runtime/sqlite overhead.
  That is allocator behavior, not retention; nothing actionable without
  fighting the GC.
- **Boot peak: 45.8–45.9 MB at module load**, well bounded; matches the spa
  lane's finding that boot is at the runtime floor.
- Heap allocation profile (`--heap-prof` on a 1-min run, samples in
  `/tmp`, not committed): top allocators are one-time costs (module load,
  `suggestionIndexFor` ~0.5 MB for the 8.8k-name index — the documented
  size) or irreducible per-request work (zlib `processChunkSync`, HTTP
  header parsing). No per-request allocation hotspot worth a
  behavior-risky churn optimization.

Conclusion: **no server-side memory changes were needed or landed.** Every
long-lived structure was audited and is bounded:

| structure | where | bound | invalidation |
|---|---|---|---|
| `#bodyCache` (encoded responses) | `src/server/server.js` | ≤32 entries, wholesale drop | TTL per token |
| deals universe cache | `src/server/handlers/public.js` | ≤1 entry (clear-then-set) | TTL + dbSignature + single-flight |
| suggestion index | `src/server/handlers/public.js` | 1 slot (~0.5 MB) | dbSignature |
| static file cache | `src/app/server.js` | ≤ file count | mtime/size per request |
| match-pair statements | `src/sqlite/app-db.js` | keyed by SQL text | — |
| rate limiting | DB-backed (not in-memory) | n/a | — |

No `setInterval`/watchers/long-lived listeners on the server side; the only
timers in the owned surfaces are the SPA's per-view debounce timeouts
(function-local).

## Changes landed (commit `fe0c14d`) — SPA client memory

### 1. History dialog no longer stays in the DOM (`public/components/detail-dialog.js`)
`loadHistory` created a `<dialog>`, and closing it (button, overlay, Esc)
only *hid* it — nothing ever removed it from `document.body`. Every
"View price history" round-trip permanently retained its whole subtree
(sparkline SVG + up-to-200-row table, tens to hundreds of KB of DOM): an
unbounded per-interaction leak of exactly the class the trial hunts. The
dialog now removes itself on the `close` event (the same pattern the detail
dialog already used), with a guard so an older dialog's late close event
can't drop the dialog that replaced it. Behavior on screen is unchanged —
a closed `<dialog>` is already invisible.

### 2. Opening a detail dialog over an existing one tears down cleanly (same file)
`openDetailDialog` retired a still-present dialog with bare `.remove()`,
which fires **no** `close` event and therefore bypassed the keydown-listener
teardown (an edge-case leak of the listener the spa lane's fix tears down on
close). Now: `if (existing.open) existing.close(); existing.remove();` —
same end state, teardown runs. Dead export `closeHistoryDialog` deleted
(no importers anywhere, incl. tests).

### 3. SPA GET cache is bounded (`public/api.js`)
`getCache` (url → structuredClone(payload)) kept one entry per distinct URL
**forever** (until any mutation cleared it): a long browse session
accumulates every product detail and 200-point history ever viewed —
measured payload sizes put 500 viewed products at ~29.5 MB retained,
growing without limit. Now `cacheSet` prunes expired entries and evicts
oldest beyond 100 entries (~1.3 MB realistic mix, ≤5.7 MB worst case).
Eviction only *removes* — a miss refetches — so cache correctness and TTL
semantics are unchanged (a wrong cache is worse than a slow one).

### Tests
- New `test/frontend/detail-dialog-dom.test.js` — synthetic-DOM harness
  (zero deps; fake elements with listener maps; `close()` throws on a
  closed dialog and fires `close` asynchronously like real `<dialog>`).
  Pins: history dialog self-removal, second-open retires the first without
  dropping it (guard), detail-over-detail keydown teardown, Esc leaves zero
  document listeners. 4 tests.
- `test/frontend/api-cache.test.js` — new eviction test: with 120 distinct
  URLs, the oldest is evicted (refetches and sees fresh data), recent ones
  stay cached. 1 test.
- Frontend: 54 pass. Targeted server/app: 207 pass. Full `npm test`:
  **1,029 pass, 0 fail** (~4 s). `npm run check`: clean.
- Also fixed en route: `perf-notes/seed-spa-fixtures.js` crashed whenever
  flags were passed (`args[++i]` on a `const`); one-line fix, flags now work.

## Rejected ideas (with evidence)

- **Server-side memory changes**: the 10-min/1.16M-request run shows flat
  post-GC RSS and stable heap — there is nothing to fix; any change would be
  risk without a symptom.
- **Multi-entry deals cache to stop retailer-rotation thrash**: with
  `?retailer=` rotation, `dealsCache.clear()` makes every deals request
  recompute (~bench: cache is keyed `retailer||'*'`, cleared on each new
  compute). But the SPA never sends `retailer` on /api/deals (deals view
  keeps `state.retailer = ''`), so real traffic never thrashes; a bigger
  multi-retailer cache would raise worst-case memory (deal objects scale
  with `deal_signals`) for a pattern that doesn't occur. Rejected.
- **`Server.stop()` + keep-alive "fix" — investigated and REVERTED.** During
  bench debugging, shutdown appeared to hang with a parked keep-alive
  connection. Landed a `closeIdleConnections()` call + regression test, then
  the red-green check showed the test passes without the fix: on Node 19+
  `server.close()` already drops idle connections, and the real hang was the
  *bench driver* attaching its `exit` listener after the child already
  exited (fixed in the driver instead). Change reverted honestly; test
  deleted (a test that cannot fail is not a test).
- **Per-request allocation churn micro-opts** (`#handle`'s per-request
  `Set`/arrays, URL parsing): heap profile shows churn fully reclaimed;
  post-GC steady state proves it. Response shapes are test-pinned; churn
  opts buy microseconds at real regression risk.
- **Deleting `api.suggestions`** (exported, zero callers in public/ or
  tests): ~50 bytes, not memory; left for the owner (below).

## Found on the way (NOT fixed — coordinator tickets)

- **Owner decision / functional bug (re-confirmed, still present):**
  `public/views/settings.js` `renderSettings` defines `render()` but never
  calls it — the Settings view (the only sign-in surface, 401 → `#settings`)
  renders an empty container. One-line fix, but it is a behavior change.
- `app.js` `currentCleanup`: `route()` invokes it but no view ever sets it —
  dead mechanism (4 lines). Build-it-or-delete-it candidate if views will
  never register teardowns.
- `api.js` `anySignal`: attaches an abort listener to caller-supplied
  signals; no caller passes one today, so the accumulation risk is latent —
  worth remembering if a view ever passes a long-lived AbortSignal.
- `api.suggestions` + `api.health` are exported client wrappers with zero
  callers (health: also zero). Dead code candidates.
- `#bodyCache` drops ALL 32 entries on overflow (wholesale clear) and the
  anon-deals token includes `computedAt`, so every recompute rotates the
  token: efficiency-only churn (memory bounded), fine at this scale.

## Needs Safari / live-browser verification (coordinator)

- History dialog: open → close via close button / overlay / Esc → dialog
  must be gone from the DOM and a second open works ("View price history"
  round-trip). The synthetic harness proves handler logic with an
  asynchronous `close` event, but real `<dialog>` event timing is
  browser-territory.
- Detail dialog over detail dialog (rapid card clicking): exactly one
  document keydown listener remains; Esc still closes.
- Settings-view emptiness is pre-existing (not from this lane) — if the
  owner approves the `render()` fix, verify sign-in flow after.

## Environment notes for re-runs

- Run: `node perf-notes/seed-spa-fixtures.js --out /tmp/perf-endurance`,
  then `BENCH_SID=<printed token> node perf-notes/run-endurance.js
  --minutes 3 --label <name>`. Samples land in `perf-notes/samples/`.
- Run-to-run RSS varies ±15 MB with the machine (V8 heap sizing); judge
  growth within a run (thirds), not absolute levels across runs.
- `node --test test/frontend/` (trailing slash) fails as MODULE_NOT_FOUND on
  Node 26.7 — use `node --test 'test/frontend/*.test.js'` (same quirk the
  lib lane hit for `test/sqlite/`).
