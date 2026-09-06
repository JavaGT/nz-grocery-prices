# Slo Naturals — campaign adapter

- **retailer id:** `slo-naturals` · **platform:** shopify
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `slo-naturals:online` (NZ online pricing)

## API

`GET https://slonaturals.com/products.json?limit=250&page=N` — standard Shopify
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
| `variant.id` | `product.id = slo-naturals:<variantId>` |

## Verification

```sh
node retailers/slo-naturals/collect.js --stdout --max-pages 1 --limit 1
```

Live-verified 2026-09-06 — returned a valid PriceObservation from the
real catalog.

## Quirks

- `/products.json` exposes only *published* products (Shopify rule).
- Zero-price placeholder variants are skipped.
