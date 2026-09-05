# The Body Shop NZ — campaign adapter

- **retailer id:** `the-body-shop-nz` · **category:** beauty
- **platform:** Shopify public storefront JSON
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `the-body-shop-nz:online`

## API

`GET https://www.thebodyshop.co.nz/products.json?limit=250&page=N` —
Shopify family (see `retailers/_lib/shopify.js`).

## Verification (2026-09-06)

Sample `the-body-shop-nz:51272487076073` "Cream Ultra Fine Bath Lily" —
valid observation.

## Quirks

- Swaps the originally-planned Kmart NZ row (Akamai bot-blocked).
