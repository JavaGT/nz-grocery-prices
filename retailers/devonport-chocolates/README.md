# Devonport Chocolates — campaign adapter

- **retailer id:** `devonport-chocolates` · **category:** chocolate
- **platform:** Shopify public storefront JSON
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `devonport-chocolates:online`

## API

`GET https://devonportchocolates.co.nz/products.json?limit=250&page=N` —
standard Shopify public catalog endpoint. Shared client + mapping:
`retailers/_lib/shopify.js`.

## Verification (2026-09-06)

Sample `devonport-chocolates:50384269377831` "Branded Corporate Easter
Gift" — valid PriceObservation from the live catalog.

## Quirks

- Corporate/gift lines sit alongside retail chocolate boxes; all are
  valid priced products.
