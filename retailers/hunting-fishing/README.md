# Hunting & Fishing New Zealand — campaign adapter

- **retailer id:** `hunting-fishing` · **category:** outdoor/sports
- **platform:** Magento 2 (server-rendered category grids)
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `hunting-fishing:online` (national online pricing)

## API discovery notes

- `POST /graphql` answers `storeConfig` (store_code `nz`) but the `products`
  scope returns `total_count: 0` for every filter/search/sort combination —
  a dead headless storefront behind the live site. Not usable.
- The classic server-rendered category grids are the working surface:
  `GET /<category>?p=N` returns ~87 product tiles per page with Magento
  priceBox `data-*` attributes.

## Endpoints used

| What | Endpoint |
|---|---|
| category page (paginated) | `GET https://www.huntingandfishing.co.nz/<category>?p=N` |

Categories walked: `hunting`, `fishing`, `camping`, `clothing`, `diving`
(top-level nav links; `?p=N` pagination until a page yields nothing new).

## Field mapping

| Payload | PriceObservation |
|---|---|
| `data-product-id` on the priceBox | `product.id = hunting-fishing:<id>` |
| `product-item-link__name` text | `product.name` |
| `data-price-type="finalPrice"` amount | current price (promo when oldPrice present) |
| `data-price-type="oldPrice"` amount | `price.regularCents` on sale tiles |
| first tile `<img src>` | `product.images.primary` |
| category path prefix | `product.categories` |

## Verification (2026-09-06)

`node retailers/hunting-fishing/collect.js --stdout --max-pages 2 --limit 1`
walked 2 pages × 5 categories → 383 unique products. Sample:
`hunters-element-apex-bino-defender...` (id 727671) — Was $229.99, Now
$149.99 → `regularCents: 22999, promoCents: 14999`, promotion savePercent 34.78.

## Quirks

- The widget carousels ("you may also like") reuse the same tile markup;
  their duplicates collapse via the id-dedupe.
- Sale tiles label prices "Now"/"Was"; both carry `data-price-amount`, so
  the amount-attribute order varies — the profile matches both orders.
