# Bargain Chemist — campaign adapter

- **retailer id:** `bargain-chemist` · **category:** online pharmacy
- **platform:** Shopify public storefront JSON
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `bargain-chemist:online` (national online pricing)

## API

| What | Endpoint |
|---|---|
| full published catalog | `GET https://www.bargainchemist.co.nz/products.json?limit=250&page=N` |
| one collection | `GET https://www.bargainchemist.co.nz/collections/<handle>/products.json?limit=250&page=N` |
| collections list | `GET https://www.bargainchemist.co.nz/collections.json?limit=250&page=N` |

No auth, no tokens, no cookies. Prices are decimal-dollar strings per variant.

## Field mapping

| Payload | PriceObservation |
|---|---|
| `variants[].price` (or `compare_at_price` when discounted) | `price.regularCents` |
| `variants[].compare_at_price` present | `price.promoCents` + derived promotion |
| `product.vendor` | `product.brand` |
| `variants[].barcode` (6–14 digits) | `product.gtin` |
| `product.product_type` + first 3 tags | `product.categories` |
| `product.images[0].src` | `product.images.primary` |
| `variant.id` | `product.id = bargain-chemist:<variantId>` |

## Verification

```sh
node retailers/bargain-chemist/collect.js --stdout --max-pages 1 --limit 1
```

Page 1 returned 5 products; sample: "RS Baking Soda HAP T/Paste 100g" (Default Title) at $7.29 NZD.

## Quirks

- The catalog opens with $0.00 "Prescription processing" placeholder variants; the adapter filters zero prices and pagination reaches the real catalog from page 2.
- `/products.json` exposes only *published* products (Shopify rule); archived/unpublished items are invisible to any client of this endpoint.
- Zero-price variants (gift-card/fee placeholders) are skipped.
