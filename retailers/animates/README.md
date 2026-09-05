# Animates — campaign adapter

- **retailer id:** `animates` · **category:** pet supplies
- **platform:** Magento 2 (server-rendered category grids; GraphQL disabled —
  `POST /graphql` redirects to the HTML homepage)
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `animates:online` (national online pricing)

## Endpoints used

| What | Endpoint |
|---|---|
| category page (paginated) | `GET https://www.animates.co.nz/<category>?p=N` |

Categories walked (nav-verified): `dog`, `cat`, `bird`, `fish`, `small-pet`,
`reptile`, `chicken`, `specials-all`. Note `?p=1` 301-redirects to the bare
category URL (fetch follows it transparently).

## Field mapping

| Payload | PriceObservation |
|---|---|
| `<!-- Product SKU --> <meta content="I154007">` | `product.id = animates:I154007` |
| `<span class="product-name">` | `product.name` |
| price-box meta sequence (`NZD` then `37.99`) | current price |
| `old-price` span / `data-price-type="oldPrice"` | `price.regularCents` on sale tiles |
| first tile `<img src>` | `product.images.primary` |
| category path prefix | `product.categories` |

## Verification (2026-09-06)

`node retailers/animates/collect.js --stdout --max-pages 1 --limit 2`
returned valid observations, e.g. `animates:I154007` "Yours Droolly Shear
Magic Ezi-Clean Slicker for Small to Medium Dogs" at $37.99 NZD (category
`dog`).

## Quirks

- Animates' theme emits double spaces inside tags (`<meta  content="…">`)
  and spaces before closing brackets (`class="product-name" >`); the
  profile regexes are whitespace-tolerant for exactly this reason.
- Product identity is the SKU (`I…`) — the first `<meta>` in the tile is
  the page position, not an id; never use it.
