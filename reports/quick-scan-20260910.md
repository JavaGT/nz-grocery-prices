# Quick-scan — 2026-09-10

Structured discovery pass over hotspots changed since 2026-08-27 (perf trial
lanes `spa`/`ingest`/`analytics`/`endurance`/`matching`/`ui`, plus the
502-retailer roster). Ranked by strength × leverage. One discovery pass; no
ground re-searched.

## Findings (ranked)

### 1. LIKE wildcard escaping is a no-op — searches containing `%` or `_` return wrong/empty results — Strong — FIXED (#47, commit 4b4c7b5)

`src/server/handlers/public.js` escaped `%`/`_` with a backslash in LIKE
patterns but no LIKE carried `ESCAPE '\'`, so SQLite treated the backslash as
a literal character and the escaping did nothing. Empirically confirmed with
`node:sqlite`: pattern `%100\%%` without ESCAPE → 0 matches against a row
named `Coke 100% recycled 1.5L`; with `ESCAPE '\'` → matches. Affected
`GET /api/products?query=` (filter + order-boost) and
`GET /api/search-suggestions`. A stale comment (old line 402) claimed the
opposite semantics.

Fix (owned layer, smallest coherent): shared `likeEscape()` helper (also
escapes a literal `\`) + `ESCAPE '\'` on all three LIKE clauses + comment
sync + 3 focused tests. `npm run check` + `node --test
test/server/public-api.test.js` (47 pass) green before commit.

### 2. docs/agent stale on deal_signals — verification.md calls it a dead unpopulated table; project-map.md says "not pre-materialized" — Strong — TICKETED #49 (docs/** is outside this lane's owned paths)

`docs/agent/verification.md:77-80` says the schema "has `deal_signals` and
`product_matches` tables that are not populated" and warns agents not to
assert against them. Reality (`src/sqlite/migrations/projection/
001_initial.sql:144-168`): `deal_signals` is created AND rebuild-populated by
`src/sqlite/deal-materialization.js`; `product_matches` is removed entirely.
`docs/agent/project-map.md:23` still says `/api/deals` calls analytics
per-request, "Not pre-materialized", contradicting lines 63-67 of the same
file. Real harm: an agent following verification.md would flag the landed
materialization tests as bugs. Decision question and proposed rewrite are in
the ticket — docs lane owns the fix.

### 3. Public handlers accept an injected `clock` but read `ctx.clock()` — health's documented bare-ctx fallback would throw — Worth exploring — FIXED via option A (#48, commit 2476ba2)

`createPublicHandlers` destructured `clock` and never used it; `health` (old
line 145) and `listDeals` (old line 555) used `ctx.clock()`, which exists only
when routed through the full Server — so the health fallback comment
("covers direct handler calls with a bare ctx") was half-true and the accepted
dependency was dead. All wiring (`src/app/server.js:256-257`,
`test/server/server-helpers.js:144-146`) passes the same clock both ways, so
the switch to the factory clock is behavior-preserving. `private.js` still
mixes both conventions (`ctx.clock()` line 17 vs injected `clock()` line 256)
— the convention decision stays open on the ticket. Verified with
`test/server/public-api.test.js` + `test/server/deals-cache.test.js` (60 pass)
+ `test/app/*.test.js` (32 pass).

### 4. Evaluate: push /api/deals filter+limit into SQL before roster scale inflates the deal universe — Speculative — TICKETED #50 (evaluate-only; implementation explicitly NOT the todo)

`defaultQueryDealSignals` (`src/server/handlers/public.js:33-45`) reads every
`deal_signals` row with no LIMIT; tiering/filter/limit happen in JS over a
per-retailer memoized universe (TTL 5 min, single-flighted, signature-
invalidated). Bounded today by the 90-day materialization window, but the
500+ retailer roster and nightly archive growth make cached-universe bytes
worth measuring against the recorded perf budgets before deciding.

## Hotspots walked and found clean

- `src/sqlite/deal-materialization.js` — pinned params + parity test; the
  unguarded `cloneJson(observation.promotion)` in analytics is safe
  (`cloneJson(undefined)` returns undefined; `src/archive-records.js:273-290`).
- `src/analytics.js` perf rework (7598410, f452073) — fused passes preserve
  summation order and stable-sort tie-breaks; parity-harnessed per commit
  message; no drift found on read.
- SPA dialog leak fixes + bounded GET cache (fe0c14d) — teardown guarded
  against late close events, FIFO eviction only removes, error path in
  `loadHistory` handled; frontend tests pin all three behaviors.
- Matching batch transaction (bff4180) — per-pair error accounting preserved,
  falls back for injectable doubles; pair tables parity-checked in-lane.
- `src/app/server.js:81` `catch {}` — intentional best-effort sidecar read
  with a comment; not an unhandled path.

## Verification run

- `npm run check` after each change — green.
- Targeted: `node --test test/server/public-api.test.js` (47 pass),
  `+ test/server/deals-cache.test.js` (60 pass combined),
  `node --test 'test/app/*.test.js'` (32 pass).
- Full `npm test` run once at end of pass (result recorded in the session
  receipt; ~1,046 tests expected).

## What I did not look at

- `retailers/` 502-roster internals — batch-generated scaffolding, covered by
  the recent full-claim doc/hardening audits (5773bc1, a380da8) and the
  registry gate test.
- Breadth pilot scripts' 5xx-survival hardening (00c357e) — recently landed
  with its own tests; ops-adjacent lanes own follow-ups.
- `src/archive-index.js` / `src/repository.js` clone/stream perf work
  (08fc98a, fcfed0e, 9dff75a, a5a814d) — each landed with serializer parity
  tests; depth went to the server lane instead.
- `src/sqlite/projection-repository.js` internals beyond the deals/search
  handler surface; `test/server/security.test.js` coverage depth.
- `perf-reports/`, `perf-notes/`, `ops/`, `docs/apis/` — foreign or
  recently-audited paths.

## Tickets

| # | Tier | Status |
|---|---|---|
| [#47](https://github.com/JavaGT/nz-grocery-prices/issues/47) | Strong | Fixed (4b4c7b5) |
| [#49](https://github.com/JavaGT/nz-grocery-prices/issues/49) | Strong (docs) | Open — docs lane |
| [#48](https://github.com/JavaGT/nz-grocery-prices/issues/48) | Worth exploring | Fix landed (2476ba2); convention decision open |
| [#50](https://github.com/JavaGT/nz-grocery-prices/issues/50) | Speculative | Open — evaluate whether worth doing |
