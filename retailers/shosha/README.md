# Shosha — campaign adapter

- **retailer id:** `shosha` · **category:** Asian grocery
- **platform:** Shopify public storefront JSON
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `shosha:online` (national online pricing)

## API

| What | Endpoint |
|---|---|
| full published catalog | `GET https://shosha.co.nz/products.json?limit=250&page=N` |

Same Shopify family as the batch-1 adapters (healthpost etc.); see
`retailers/_lib/shopify.js` for the shared field mapping.

## Verification

`node retailers/shosha/collect.js --stdout --max-pages 1 --limit 1`
returned "Ultra Bar STICK 2.0 Refillable | Starter Bundle" with a valid
PriceObservation.

## Quirks

- Shosha swapped into the 50 for Kings Plant Barn (Vue SPA, no
  curl-discoverable product API).
