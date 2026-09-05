# Computer Lounge — campaign adapter

- **retailer id:** `computer-lounge` · **category:** PC hardware
- **platform:** Shopify public storefront JSON
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `computer-lounge:online` (national online pricing)

## API

| What | Endpoint |
|---|---|
| full published catalog | `GET https://www.computerlounge.co.nz/products.json?limit=250&page=N` |
| one collection | `GET https://www.computerlounge.co.nz/collections/<handle>/products.json?limit=250&page=N` |
| collections list | `GET https://www.computerlounge.co.nz/collections.json?limit=250&page=N` |

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
| `variant.id` | `product.id = computer-lounge:<variantId>` |

## Verification

```sh
node retailers/computer-lounge/collect.js --stdout --max-pages 1 --limit 1
```

Page 1 returned 5 products; sample: "Hyte Y40 Shop-The-Look Bundle" (Default Title) at $223.20 NZD.

## Quirks

- `/products.json` exposes only *published* products (Shopify rule); archived/unpublished items are invisible to any client of this endpoint.
- Zero-price variants (gift-card/fee placeholders) are skipped.
