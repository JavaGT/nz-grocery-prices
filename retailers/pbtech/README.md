# PB Tech — campaign adapter

- **retailer id:** `pbtech` · **category:** computers & electronics
- **platform:** custom SSR tiles (html-grid family)
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `pbtech:online` (national online pricing)

## API discovery notes

- Category pages render ~90 product tiles server-side; pagination is
  client-side (no working ?page= URLs), so the walk covers page 1 of each
  configured category.
- Prices appear twice per tile (excl-GST `gex` + incl-GST `ginc`); the
  adapter takes the GST-inclusive (retail) price.

## Endpoints used

| What | Endpoint |
|---|---|
| category page (single SSR page) | `GET https://www.pbtech.co.nz/<category>` |

Categories: `category/Computers/Laptops`, `category/Computers/PCs`,
`category/Headphones-Audio/Headphones`, `category/Peripherals/Monitors`,
`category/Peripherals/Cables`, `category/Phones-GPS/Smartphones`.

## Field mapping

| Payload | PriceObservation |
|---|---|
| `data-product-code` | `product.id = pbtech:<code>` |
| `h2/h3.np_title` pair (joined) | `product.name` |
| `ginc` block `full-price` span | `price.regularCents` |
| first tile `<img src>` | skipped (lazy placeholders) |
| urlFromId template | `source.url = /product/<code>` |

## Verification (2026-09-06)

`node retailers/pbtech/collect.js --stdout` produced 489 valid
observations with zero rating-title contamination. Sample:
`pbtech:NBKAPP1318025613` "Apple 13-inch MacBook Neo Laptop…" $1268.00.

## Quirks

- Tile slices start at the `product-title-holder` div; the product anchor
  (and its title attr) sits before that div, so `urlFromId` builds the
  canonical product URL instead of parsing an href.
- Rating titles (`4.8 out of 5 Stars`) exist inside the same slice and must
  not leak into names — the joinName path bypasses the generic title
  fallback.
