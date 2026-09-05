# Bunnings Warehouse NZ — campaign adapter

- **retailer id:** `bunnings` · **category:** hardware & garden
- **platform:** Next.js — dehydrated react-query state (Coveo search) in __NEXT_DATA__
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `bunnings:online` (NZ national online pricing)

## API discovery notes

- Bunnings NZ proxies its Apigee backend through `/_apis` (session-tied),
  and category HUB pages (`/products/garden`) are navigation only. The
  working surface is LEAF category pages, whose __NEXT_DATA__ embeds the
  Coveo `category-search` query: 36 products/page, NZD prices, server-side
  `?page=N` pagination.

## Endpoints used

| What | Endpoint |
|---|---|
| leaf category grid | `GET https://www.bunnings.co.nz/products/<hub>/<leaf>?page=N` |

Categories: `garden/plants`, `garden/gardening`, `garden/pest-control`,
`garden/lawn`, `garden/plant-pots-planters-baskets`,
`garden/garden-hand-tools` (more leaves exist under the other hubs).

## Field mapping (Coveo `raw` record)

| Payload | PriceObservation |
|---|---|
| `code` (== itemnumber) | `product.id = bunnings:<code>` |
| `name` | `product.name` |
| `brandname` | `product.brand` |
| `price` (NZD) | `price.regularCents` |
| `imageurl` | `product.images.primary` |
| `productroutingurl` | `source.url` |

## Verification (2026-09-06)

`node retailers/bunnings/collect.js --stdout --max-pages 1` produced 216
valid observations across 6 leaf categories. Sample: `bunnings:0431151`
"100mm Assorted Potted Colour" $1.80.

## Quirks

- Hub pages (`/products/garden`) carry no products; only leaves do.
- Sale pricing fields were not present in the sampled pages; the raw
  record may expose them seasonally (adapter passes price only today).
