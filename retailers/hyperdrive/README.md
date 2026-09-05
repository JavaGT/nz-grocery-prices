# HyperDrive — campaign adapter

- **retailer id:** `hyperdrive` · **category:** tyres & wheels
- **platform:** N2 ERP (.NET) storefront — server-rendered category grids
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `hyperdrive:online` (NZ national online pricing)

## API discovery notes

- The `/products/landing/...` pages are tyre-size content hubs without
  product data; the working surface is the category grid
  `/products/category/<id>/<slug>?page=N` (32 tiles/page, SSR).

## Endpoints used

| What | Endpoint |
|---|---|
| category grid (paginated) | `GET https://www.hyperdrive.co.nz/products/category/<id>/<slug>?page=N` |

Categories: `/products/category/227/tyres` (new),
`/products/category/2169/used-tyres`.

## Field mapping

| Payload | PriceObservation |
|---|---|
| `data-productid` on the wishlist span | `product.id = hyperdrive:<id>` |
| `div.name` | `product.name` |
| `price grid` span (`Now $129.99`) | current price |
| `<del>` / line-through amounts | `price.regularCents` on sale tiles |
| brand image `alt` | `product.brand` |

## Verification (2026-09-06)

`node retailers/hyperdrive/collect.js --stdout --max-pages 1` produced 39
valid observations across both categories. Sample: `hyperdrive:105077`
"Green-Max Et" $77.99, brand LINGLONG.

## Quirks

- The tyre-size wizard data (rim/profile widths) is embedded as JS arrays
  and intentionally ignored.
- Category pages also exist for wheels/batteries — add their ids to
  `CATEGORIES` to widen coverage.
