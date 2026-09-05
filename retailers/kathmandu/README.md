# Kathmandu New Zealand — campaign adapter

- **retailer id:** `kathmandu` · **category:** outdoor clothing & gear
- **platform:** Shopify public storefront JSON
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `kathmandu:online` (national online pricing)

## API

| What | Endpoint |
|---|---|
| full published catalog | `GET https://www.kathmandu.co.nz/products.json?limit=250&page=N` |
| one collection | `GET https://www.kathmandu.co.nz/collections/<handle>/products.json?limit=250&page=N` |
| collections list | `GET https://www.kathmandu.co.nz/collections.json?limit=250&page=N` |

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
| `variant.id` | `product.id = kathmandu:<variantId>` |

## Verification

```sh
node retailers/kathmandu/collect.js --stdout --max-pages 1 --limit 1
```

Page 1 returned 5 products; sample: "Amphi Core Gear Tote - 28L - Black Stingray" (Black Stingray / 28LTR) at $99.98 NZD.

## Quirks

- Outlet pricing is common: compare_at_price maps to promo observations for a large share of the catalog.
- `/products.json` exposes only *published* products (Shopify rule); archived/unpublished items are invisible to any client of this endpoint.
- Zero-price variants (gift-card/fee placeholders) are skipped.
