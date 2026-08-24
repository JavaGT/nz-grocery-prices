/**
 * Public root surface of nz-grocery-prices (CORE-5).
 *
 * Exactly this export list, nothing else: persistence (the two observation
 * repositories), the archive facade, pure analytics, and observation
 * validation. The agent-feed shape returned by toAgentFeed / agentFeed is an
 * intentionally stable contract.
 *
 * Deliberately NOT exported here: retailer clients (they live on the
 * "nz-grocery-prices/foodstuffs", "/woolworths", "/freshchoice", and
 * "/warehouse" subpath exports), and the archive internals — ArchiveIndex,
 * record codecs, fingerprints, locking, repair, and migration helpers.
 *
 * src/index.d.ts is the hand-maintained type contract for these exports;
 * test/types-surface.test.js fails when the runtime and the contract drift
 * apart.
 */
export { PriceArchive } from "./archive.js";
export {
  buildPriceSeries,
  calculateOngoingSales,
  calculateSales,
  toAgentFeed,
} from "./analytics.js";
export {
  JsonlObservationRepository,
  MemoryObservationRepository,
} from "./repository.js";
export { parseObservation } from "./domain/observation.js";
