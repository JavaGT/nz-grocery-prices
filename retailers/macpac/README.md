# Macpac — campaign adapter

- **retailer id:** `macpac` · **category:** outdoor clothing & gear
- **platform:** SFCC, server-rendered category grids (`html-grid` family)
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `macpac:online` (national online pricing)

## API discovery notes

- `Search-UpdateGrid` / `Search-Update` controllers are **410 Gone**; the
  GraphQL-style endpoints are absent. Category pages render classic SFCC
  tiles server-side and paginate by offset: `GET /<category>?start=N&sz=24`.
- Member pricing is first-class on Macpac (NZ$229.99 standard / NZ$149.99
  members is typical) and maps to `price.memberCents`.

## Endpoints used

| What | Endpoint |
|---|---|
| category grid (offset paginated) | `GET https://www.macpac.co.nz/<category>?start=N&sz=24` |

Categories walked (nav-verified): `all-clothing`, `backpacks-bags`,
`tents-shelters`, `sleeping-bags`, `camping-hiking`, `footwear`, `climbing`,
`snow`.

## Field mapping

| Payload | PriceObservation |
|---|---|
| `data-itemid` | `product.id = macpac:<itemid>` |
| `thumb-link` title | `product.name` |
| `price-standard` span | `price.regularCents` |
| `price-value` span (Members) | `price.memberCents` |
| GTM input `item_brand` | `product.brand` |
| first tile `<img src>` | `product.images.primary` |

## Verification (2026-09-06)

`node retailers/macpac/collect.js --stdout --max-pages 1` produced 97 valid
observations. Sample: `macpac:122871` "Macpac Men's 180 Merino Boxers"
regular $59.99, members $47.99.

## Quirks

- `?start=N` past the category end returns HTTP 200 with an empty grid —
  the walk stops on the first no-new-tiles page.
- `price-standard has-club-price` means the standard price is shown struck
  through because members pay less; non-member specials use plain
  `price-sales` (handled by the same finalPrice fallbacks).
