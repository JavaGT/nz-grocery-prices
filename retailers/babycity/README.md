# Babycity — campaign adapter

- **retailer id:** `babycity` · **category:** baby
- **platform:** Odoo (custom "tp" theme) — SSR category grids
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `babycity:online`

## API discovery

`/shop` alone renders no grid, but category pages
`/shop/category/<id>?page=N` (301 to the slugged URL, fetch follows)
server-render 7-up product grids. Prices are Odoo monetary spans: sale
price first, original in a `<del>`.

## Field mapping

| Payload | PriceObservation |
|---|---|
| hidden `product_id` input | `product.id = babycity:<id>` |
| `<h6><a>name</a>` | `product.name` |
| first `oe_currency_value` | current price |
| `<del>` oe_currency_value | `price.regularCents` on sale tiles |
| first tile img | `product.images.primary` |

## Verification

78 valid observations across 6 numeric categories (`/shop/category/{10,11,
12,103,142,193}`); sample tile "Mountain Buggy® duet™ Travel System
Bundle" at $2,149.96 (bundle price).
