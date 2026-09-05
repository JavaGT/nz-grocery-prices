# The Fabric Store — campaign adapter

- **retailer id:** `the-fabric-store` · **platform:** Shopify public storefront JSON
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `the-fabric-store:online` (NZ online pricing)

## API

`GET https://thefabricstore.co.nz/products.json?limit=250&page=N` — the standard Shopify
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
| `variant.id` | `product.id = the-fabric-store:<variantId>` |

## Verification

```sh
node retailers/the-fabric-store/collect.js --stdout --max-pages 1 --limit 1
```

Live-verified 2026-09-06 — the command above returned a valid
PriceObservation from the real catalog.

## Quirks

- `/products.json` exposes only *published* products (Shopify rule).
- Zero-price placeholder variants are skipped.
