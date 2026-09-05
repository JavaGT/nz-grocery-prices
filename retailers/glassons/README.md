# Glassons — campaign adapter

- **retailer id:** `glassons` · **category:** fashion
- **platform:** Black Pepper — `window.category` JSON in page source
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `glassons:online` (NZ store view, NZD)

## API discovery

Category pages embed the full payload as `window.category = { ...{...} }`
(Javascript object spread around a serialized JSON payload — the shared
estar-category parser handles the spread). The `/nz` path prefix selects
the NZ store view; the bare `.com` view is locale "au" (AUD).

| What | Endpoint |
|---|---|
| category page (page 1) | `GET https://www.glassons.com/nz/c/<category>` |

Categories: `nz/c/clothing`, `nz/c/new`, `nz/c/best-sellers`, `nz/c/sale`,
`nz/c/accessories`. Grid pagination is client-side (infinite scroll).

## Verification

67 valid observations across 5 categories; payload fields: `productid`,
`description`, `label` (brand), `stylecolour.urlkey`,
`stylecolour.variants[].unitprice / baseunitprice`.

## Quirks

- Page-1-per-category only (client-side infinite scroll).
- The default `.com` storefront is AUD — never drop the `nz/` prefix.
