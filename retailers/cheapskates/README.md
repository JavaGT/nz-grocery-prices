# Cheapskates — campaign adapter

- **retailer id:** `cheapskates` · **category:** skate/surf retail
- **platform:** Shopify public storefront JSON
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `cheapskates:online`

## API

`GET https://cheapskates.co.nz/products.json?limit=250&page=N` — same Shopify family as
the other campaign adapters (see `retailers/_lib/shopify.js`).

## Verification (2026-09-06)

`node retailers/cheapskates/collect.js --stdout --max-pages 1 --limit 1`
returned a valid PriceObservation from the live catalog.

## Quirks

- None known.
