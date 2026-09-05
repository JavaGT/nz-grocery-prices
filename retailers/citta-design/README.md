# Citta Design — campaign adapter

- **retailer id:** `citta-design` · **category:** homeware
- **platform:** Shopify public storefront JSON
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `citta-design:online`

## API

`GET https://www.cittadesign.com/products.json?limit=250&page=N` —
Shopify family (see `retailers/_lib/shopify.js`).

## Verification (2026-09-06)

Sample `citta-design:53991986725164` "Pinstripe Organic Cotton Lodge
Pillowcase Pair" — valid observation.

## Quirks

- Swaps the originally-planned Chemist Warehouse row (its FredHopper grid
  API is session/TLS dependent — see blocked section).
