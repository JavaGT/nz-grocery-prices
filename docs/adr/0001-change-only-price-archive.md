# ADR 0001: Use a change-only normalized archive

## Status

Accepted — 2026-07-13.

## Context

Daily store-special collection otherwise rewrites the same product metadata and price values thousands of times. The archive must compare a product across stores, retain price history, identify changed product metadata, and tell analytics whether a special is still present.

## Decision

Use append-only v2 JSONL records:

- content-addressed product and store revisions, hashed with SHA-256 over stable JSON;
- offer revisions keyed by `productId + storeId`, written only when price, promotion, or source changes;
- one special-listing delta per store and collection, containing added/removed offer IDs and a listing hash.

Queries reconstruct observations from these records. The current special state comes from listing snapshots; product revision history is exposed through `PriceArchive.productHistory()` and the `grocery-prices product` command.

## Consequences

Unchanged daily collection becomes a handful of snapshot records while preserving an audit trail for prices and metadata. A normalized initial archive can be larger than raw repeated observations, but subsequent growth is substantially smaller.

An advertised-specials snapshot proves presence only for the collected special scope. Targeted `track` searches intentionally do not assert that an item remains on special. Product IDs shared by Foodstuffs can produce store-specific metadata variants; each unique metadata hash is retained once rather than alternately rewriting the same product record.

Legacy observation JSONL remains readable and `npm run compact` rewrites it to v2.
