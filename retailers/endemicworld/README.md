# Endemic World — campaign adapter

- **retailer id:** `endemicworld` · **category:** art prints
- **platform:** Shopify public storefront JSON
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `endemicworld:online`

## API

`GET https://endemicworld.com/products.json?limit=250&page=N` — same Shopify family as
the other campaign adapters (see `retailers/_lib/shopify.js`).

## Verification (2026-09-06)

`node retailers/endemicworld/collect.js --stdout --max-pages 1 --limit 1`
returned a valid PriceObservation from the live catalog.

## Quirks

- None known.
