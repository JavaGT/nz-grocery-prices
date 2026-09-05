# Life Pharmacy — campaign adapter

- **retailer id:** `life-pharmacy` · **category:** pharmacy (Green Cross NZ)
- **platform:** Shopify public storefront JSON
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `life-pharmacy:online` (national online pricing)

## API

| What | Endpoint |
|---|---|
| full published catalog | `GET https://www.lifepharmacy.co.nz/products.json?limit=250&page=N` |
| one collection | `GET https://www.lifepharmacy.co.nz/collections/<handle>/products.json?limit=250&page=N` |
| collections list | `GET https://www.lifepharmacy.co.nz/collections.json?limit=250&page=N` |

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
| `variant.id` | `product.id = life-pharmacy:<variantId>` |

## Verification

```sh
node retailers/life-pharmacy/collect.js --stdout --max-pages 1 --limit 1
```

Page 1 returned 5 products; sample: "Circa Scent Oil Lavender & Geranium 10ml" (Default Title) at $24.95 NZD.

## Quirks

- `/products.json` exposes only *published* products (Shopify rule); archived/unpublished items are invisible to any client of this endpoint.
- Zero-price variants (gift-card/fee placeholders) are skipped.
