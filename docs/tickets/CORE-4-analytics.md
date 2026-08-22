# CORE-4 — Analytics hardening

> **Status: COMPLETE + REVIEWED (2026-08-23).** Commits `5123bed`, `adf6093`,
> review round `6c4b2dc`. Hostile review (GPT 5.6 Luna) → all findings fixed:
> `at` now REQUIRED in analytics functions (determinism contract enforced),
> invalid observedAt skipped at group entry, invalid query.at throws,
> handler-level /api/deals golden proves stale-promo baselines at regular
> cents, offset-form ISO boundary tests added. Gate 85/85.
Deterministic analytics with centralized price semantics and an exhaustive
edge-case suite.

## Scope
- `selectEffectivePrice(observation, { pricePolicy, at })`: one internal
  source of truth used by calculateSales, calculateOngoingSales, and series
  building [SOL-10]. Baseline points evaluate promotion activity at their own
  `observedAt`; ongoing sales evaluate at query `at`; inclusive boundaries.
  Decide explicitly how expired promotions affect baseline cents.
- Fix input-ordering assumption: sort each offer group by observedAt inside
  calculateSales (`relevant.at(-1)` currently trusts caller order) [SOL-9].
- Clock injection at PriceArchive level only: `PriceArchive` gets optional
  `clock` and supplies `query.at` when absent (agentFeed's `new Date()` moves
  there). Pure analytics keeps explicit `at` params — no clock param inside
  analytics functions [SOL-9].
- `buildPriceSeries(observations, { pricePolicy })` pure transform returning
  series grouped explicitly by offer (productId+storeId), points shaped
  `{ observedAt, cents, kind }`. A convenience wrapper on PriceArchive may
  accept `{ productId, storeId }` filters [SOL-8].
- Edge-case tests: empty input, single sample, promo boundary exactly at
  startsAt / endsAt, member policy on/off, unsorted input, duplicate keys,
  all-time-low tie, expired-promotion stale observation.

## Constraints
- Pure functions, no I/O, no clock reads inside src/analytics.js.
- Existing exported signatures backward-compatible (new params optional).

## Behavior-change flag [GROK-8]
Evaluating promotion windows in sales baselines (via selectEffectivePrice)
CHANGES `/api/deals` output (handlers/public.js ~367-375). Ship with
before/after golden fixtures on the handler level and label it a behavior fix
in the outcome — not an invisible edge-case tweak. CORE-5 depends on this
ticket too.

## Tests
Extend `test/analytics.test.js`.

## Verification
`npm run check` → `node --test test/analytics.test.js test/archive.test.js`
→ `npm test`.

## Blocked by
CORE-1 (uses domain validation helpers).
