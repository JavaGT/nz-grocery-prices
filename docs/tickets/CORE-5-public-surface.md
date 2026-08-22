# CORE-5 — Public surface & types

## Summary
Make the package's public surface coherent and honest: a small root export
list, `.d.ts` files that match reality, a README quickstart.

## Scope
- Root `src/index.js` exports exactly [SOL-11]:
  `PriceArchive`, `JsonlObservationRepository`, `MemoryObservationRepository`,
  `parseObservation`, `calculateSales`, `calculateOngoingSales`,
  `buildPriceSeries`, and `toAgentFeed` (agent-feed format is an intentional
  stable contract). Nothing else.
- Retailer clients stay on existing subpath exports; no adapter/parser
  re-exports at root. Do NOT export ArchiveIndex, locking, record codecs,
  hashes, repair, or migration internals.
- `.d.ts` files are hand-maintained public contracts, verified two ways:
  exported-runtime-names test AND consumer fixture files that exercise the
  declared signatures (imported in a test to catch signature drift, since
  there is no TS compiler here).
- README: ~20-line quickstart (record → query → sales) plus API table.

## Constraints
- Zero dependencies; no build step. `npm run pack:check` must pass.

## Tests
`test/types-surface.test.js` (names + consumer fixtures); pack:check.

## Verification
`npm run check` → `node --test test/types-surface.test.js` → `npm test` →
`npm run pack:check`.

## Blocked by
CORE-1, CORE-3, CORE-4 (final integration ticket).
