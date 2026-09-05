# Iko Iko — campaign adapter

- **retailer id:** `iko-iko` · **platform:** Shopify public storefront JSON
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `iko-iko:online` (NZ online pricing)

## API

`GET https://ikoiko.co.nz/products.json?limit=250&page=N` — the standard Shopify
public catalog endpoint (250 products/page, per-variant NZD prices, no
auth). Shared client + mapping: `retailers/_lib/shopify.js`.

## Field mapping

| Payload | PriceObservation |
|---|---|
| `variants[].price` (or `compare_at_price` when discounted) | `price.regularCents` |
| `variants[].compare_at_price` present | `price.promoCents` + derived promotion |
| `product.vendor` | `product.brand` |
| `variants[].barcode` (8–14 digits) | `product.gtin` |
| `product.product_type` + first tags | `product.categories` |
| `product.images[0].src` | `product.images.primary` |
| `variant.id` | `product.id = iko-iko:<variantId>` |

## Verification

```sh
node retailers/iko-iko/collect.js --stdout --max-pages 1 --limit 1
```

Live-verified 2026-09-06 — the command above returned a valid
PriceObservation from the real catalog.

## Quirks

- `/products.json` exposes only *published* products (Shopify rule).
- Zero-price placeholder variants are skipped.
