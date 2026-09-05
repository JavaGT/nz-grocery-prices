# Lane: data layer — measurements, changes, trade-offs

Owner: coordinator (subagent lane A was killed by a provider rate limit before
starting; its mission was done by the coordinator in this worktree).

## Test suite speed — 12.25s → 2.78s (4.4x)

Per-test profiling (`node --test --test-reporter=spec`) showed the wall time
was dominated by real sleeps, not compute:

| Test | Before | After | Fix |
|---|---|---|---|
| foodstuffs-mobile "throws on non-ok response" | 9.0s | <5ms | slept through real 3s+6s retry backoffs |
| foodstuffs-mobile "retries transient network failures" | 3.0s | <5ms | same |
| private API / Auth / security / rate-limiting suites | ~5.7s | ~0.8s | production scrypt (N=16384, ~100ms per hash) run on every register/login |

Fixes (commits 2e29b60, 170bbb5):

- `MobileFoodstuffsClient` gained `options.retryBackoffMs` (default
  `RETRY_BACKOFF_MS = 3000` unchanged). Tests inject 1ms; retry counts,
  ordering, and error semantics are identical.
- `Auth` gained `options.scryptOptions` (production default unchanged).
  Register and verify always use the SAME options on one instance, so the
  test cost (N=256) is self-consistent. The shared test server harness
  (`test/server/server-helpers.js`) defaults to the cheap cost; any test can
  override.

Trade-offs: none at runtime — production hashing cost and retry pacing are
byte-identical. Deliberately NOT done: the `local-archive-runner` tests
(~1.8s) spawn a real shell script with a fake npm; that is their semantics
(verification.md documents them as the real-runner check), so they stay.

## Projection DB size — 17MB → 15.6MB (-8%), search 4.4ms → 0.73ms

dbstat breakdown of the baseline 17MB `data/prices.db`: product_revisions
~6.0MB, offer_revisions ~7.5MB (incl. a 1.4MB UNIQUE autoindex + a 680KB
`idx_or_offer_key`), products ~3MB, special_snapshots 0.56MB.

Changes (commit 4477f36):

1. Dropped creation of `deal_signals` + `product_matches` (documented dead
   artifacts; zero references outside the schema). The schema test now
   asserts they STAY deleted.
2. Reordered `offer_revisions` UNIQUE to `(offer_key, observed_at, rev_hash)`
   — identical uniqueness — and removed `idx_or_offer_key` (680KB): the
   unique index now serves offer-key equality AND observed_at ordering
   (EXPLAIN QUERY PLAN: no temp b-tree).
3. `PRAGMA page_size=8192` at rebuild start (before WAL locks it in):
   −480KB more, and product-search p50 dropped 4.4ms → 0.73ms (shallower
   index, fewer page walks).

Trade-offs / safety: the projection is a rebuildable throwaway — rebuild()
always builds a fresh temp DB and atomically renames, and no code path
applies migrations to an existing projection DB, so editing 001_initial.sql
is safe (verified: only caller is the fresh-tmpDb path). Considered and
REJECTED: dropping `product_revisions` (6MB!) — `productHistory()` is a
public, type-gated library API; dropping `offer_revisions.source_data` —
read by two handlers and by rebuild-time materialization.

## Measured, honest stops

- Fuzzy matching (`matching-cli --fuzzy`): 0.17s on fresh DBs, capped at
  1000 candidates — no problem to fix.
- Library JSONL load: 340ms / 216MB RSS (12MB archive); 672ms / 540MB
  (22MB). No consumer is on this path today (server uses SQLite; collectors
  are network-bound; Workbench has no grocery-prices project). Speeding it
  up would mean weakening per-line hash verification for no user-visible
  gain.
- build-db: 1.9-2.0s — already dominated by JSON parse + sha256 per record;
  not worth complexity.

## Verification

Every step: `npm run check` + full `npm test` (854 pass / 0 fail) +
targeted `test/sqlite/` runs (116 pass) + rebuild + bench-server before/
after.
