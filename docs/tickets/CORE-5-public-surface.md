# CORE-5 — Public surface & types

> **Status: COMPLETE + hostile-reviewed (2026-08-24).** Commits `8161b9f`,
> `5bc2fb2`, review fixes in `bdf334a`. Grok review: no blocker. Root exports
> exactly the eight ticket names; domain shapes are single-sourced in
> `src/domain/observation.d.ts` (root + adapters re-export, no local copies);
> AgentFeed name fields are optional and runtime-pinned; freshchoice subpath
> now declares `listStores`/`storeListUrl`/`parseFreshChoiceStoreList`;
> fixtures import the real module and the exports map is asserted. Suite:
> **631/631**, pack:check green.
>
> Deferred (owner decision, not a defect): `"files"` still ships `scripts/`
> and app code (`src/app`, `src/sqlite`) inside the tarball — harmless while
> unpublished, worth trimming before any real npm publish.

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
