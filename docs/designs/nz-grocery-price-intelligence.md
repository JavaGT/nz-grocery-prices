# Design: New Zealand Grocery Price Intelligence Library

## Reframe

The request begins as a multi-retailer grocery shopping library. The durable
need is a local-first price intelligence engine: collect store-specific price
observations, retain enough history to distinguish a real discount from a sale
label, and return compact structured data to notification and meal-planning
agents.

## Premises

- Prices belong to a specific store. Retailer- or region-wide figures are
  derived views, because PAK'nSAVE and New World prices vary by branch.
- An observation preserves ordinary, promotional, and member-only prices as
  distinct values. Analytics use the effective price selected by an explicit
  membership policy.
- Historical comparisons are exact-SKU comparisons. Cross-retailer matching is
  accepted automatically only when a strong identifier such as a GTIN agrees;
  fuzzy matches must remain reviewable.
- The useful first release is an embeddable data library and agent feed, not a
  scheduler, notification service, user interface, or meal planner.
- Public website data is the first ingestion source. Android app traffic is a
  fallback for a retailer whose public site cannot provide required data, not a
  prerequisite for the library.
- Retailer integrations are fallible edge adapters. Captured observations and
  historical analytics must remain usable when an upstream endpoint changes.

## Alternatives considered

| Approach | Scope | Human effort | Agent effort | Risk |
| --- | --- | ---: | ---: | --- |
| A: Intelligence core first | History, analytics, favourites, agent feed, and one live retailer platform | 1-2 weeks | about 1 day | Low |
| B: All retailer scrapers first | Five live integrations before stable analytics | 3-5 weeks | 2-4 days | High |
| C: Full shopping assistant | Collection, matching, alerts, recipes, basket optimisation, and UI | 2-3 months | 1-2 weeks | Very high |

## Approach

Chosen: Approach A, intelligence core first, followed by thin live adapters.

It validates the load-bearing behavior immediately: whether accumulated price
observations can identify meaningful weekly drops and all-time lows. The live
adapters now cover the shared Foodstuffs platform used by PAK'nSAVE and New
World, plus Woolworths, FreshChoice, and The Warehouse. They plug into the same
observation contract without coupling historical data to transient HTTP
response shapes.

## Core capabilities

1. Record normalized product, store, price, promotion, membership, source, and
   collection-time data without losing retailer identifiers.
2. Query observations by product, store, retailer, and time range.
3. Compare the current effective price with the preceding rolling average and
   report drops at or above a caller-supplied percentage threshold.
4. Detect a new all-time low using only observations before the current one as
   the baseline.
5. Track favourites independently of retailer listings, using canonical product
   IDs and optional strong cross-retailer aliases.
6. Produce serializable, bounded sale summaries suitable for an LLM or another
   deterministic planning process.
7. Ingest retailer data through adapters with injectable HTTP clients so
   parsers can be tested against captured, non-live responses.

## Initial public API

- `PriceArchive.record(observations)` appends normalized observations.
- `PriceArchive.history(query)` returns chronologically ordered observations.
- `PriceArchive.findSales(query)` calculates percentage drops and all-time lows.
- `PriceArchive.ongoingSales(query)` returns current advertised promotions.
- `PriceArchive.agentFeed(query)` returns both promotion and historical signals
  in a compact JSON-ready snapshot.
- Retailer clients isolate store discovery, product collection, and source
  normalization.

Money is stored as integer New Zealand cents. Timestamps are UTC ISO strings at
the API edge and integer epoch milliseconds in persistence. Percentages are
expressed as ordinary percentage points, so `20` means a twenty percent drop.

## Storage

The package defines a narrow observation repository and includes an append-only
JSON Lines implementation for zero-dependency local use. UTC ISO timestamps are
preserved as supplied at the API edge. Records are immutable;
corrections are new observations carrying a new collection timestamp. The
contract permits a later SQLite implementation without changing analytics or
retailer adapters.

## Out of scope for the first release

- Automatic fuzzy merging of products without a GTIN or explicit alias.
- Scheduled crawling, retries across days, notifications, and credentials.
- Meal generation, nutrition analysis, and multi-store basket optimisation.
- Authenticated carts, checkout, or loyalty-account automation.
- Authenticated mobile traffic interception or loyalty-account automation.
- Guaranteed compatibility with undocumented retailer endpoints.

## Risks

- Retailer endpoints change: keep raw response mapping inside versioned
  adapters, inject HTTP, and fail with retailer-specific errors.
- A displayed special is not genuinely cheap: calculate against historical
  effective prices rather than trusting promotion labels.
- Member prices distort comparisons: require an explicit member-price policy
  and expose the selected price kind.
- Sparse history creates misleading percentages: expose sample count and the
  exact baseline window, and require a configurable minimum sample count.
- Duplicate collection inflates the baseline: deduplicate identical
  product/store/timestamp observations at the repository boundary.
- Automated collection may conflict with retailer rules or load limits: callers
  control scheduling and rate limits, and integrations use only data available
  to ordinary public clients.

## Acceptance criteria

- Recording a price history and querying a 20% threshold identifies qualifying
  weekly drops but excludes smaller changes.
- A price equal to the previous minimum is not reported as a new all-time low;
  a lower price is.
- The current observation is excluded from its own historical average.
- Regular and member-price policies produce deterministic, distinct results.
- Agent output can be passed directly to `JSON.stringify` and is ordered by the
  strongest discount first.
- History survives closing and reopening the included local repository.
- A capped live smoke request from every supported retailer maps into the
  retailer-neutral observation model before parser fixtures are introduced.
