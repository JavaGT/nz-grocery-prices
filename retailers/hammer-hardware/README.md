# Hammer Hardware — campaign adapter

- **retailer id:** `hammer-hardware` · **category:** hardware (national co-op)
- **platform:** Shopify public storefront JSON
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `hammer-hardware:online`

## API

`GET https://www.hammerhardware.co.nz/products.json?limit=250&page=N` —
same Shopify family as batch 1 (see `retailers/_lib/shopify.js`).

## Verification

Sample `hammer-hardware:46076750364860` "Nouveau" — valid observation,
2026-09-06.

## Quirks

- Co-op member store pricing is national online only; individual member
  stores are not modelled.
