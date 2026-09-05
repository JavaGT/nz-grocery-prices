# Mitre 10 — campaign adapter

- **retailer id:** `mitre-10` · **category:** hardware & DIY
- **platform:** SAP Commerce Cloud (Angular SSR storefront + open OCC API)
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `mitre-10:online` (national online pricing)

## API discovery notes

- The Algolia hints in the storefront belong to the search UI, but the
  real data plane is SAP OCC at `ccapi.mitre10.co.nz`.
- Free-text `products/search` is **deactivated through OCC** (always 0
  results, whatever the query format), but the product **detail** endpoint
  is fully open with `fields=FULL`.
- Catalog discovery therefore uses the sitemap index
  (`/sitemap.xml`) → 83 `Product-en-NZD-*` shards → product URLs
  (`/shop/<slug>/p/<code>`), then one OCC detail request per product.
  Budgeted collection: `--max-pages` shards × `--page-size` products.

## Endpoints used

| What | Endpoint |
|---|---|
| product detail | `GET https://ccapi.mitre10.co.nz/occ/v2/mitre10/products/<code>?fields=FULL` |
| sitemap index | `GET https://www.mitre10.co.nz/sitemap.xml` |
| sitemap shards | `GET https://www.mitre10.co.nz/medias/sys_master/root/…/Product-en-NZD-<n>-….xml` |

## Field mapping

| Payload | PriceObservation |
|---|---|
| `code` | `product.id = mitre-10:<code>` |
| `name` | `product.name` |
| `brandName` | `product.brand` |
| `price.value` | current price (`promoCents` when below regular) |
| `regularPrice.value` | `price.regularCents` |
| `canonicalUrl` | `source.url` |
| `images[0].url` (relative) | `product.images.primary` (resolved against ccapi) |

## Verification (2026-09-06)

`node retailers/mitre-10/collect.js --stdout --max-pages 1 --page-size 5`
produced 5 valid observations. Samples: `mitre-10:52229` "Nylon Fishing
Line" $11.98 (Senma), `mitre-10:52375` "Sinkers" $6.98 (Kumho).

## Quirks

- PDP HTML also embeds SSR JSON (`"price":{"formattedValue":"$6.98"…}`),
  so the storefront fallback works if the OCC API ever closes.
- `nationalPromo` / `regionalPromo` flags exist on `price`; regional
  pricing is ignored — the adapter records the national price.
