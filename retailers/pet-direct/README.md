# Petdirect — campaign adapter

- **retailer id:** `pet-direct` · **category:** pet supplies
- **platform:** BigCommerce (Stencil), server-rendered product cards
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `pet-direct:online` (national online pricing)

## Endpoints used

| What | Endpoint |
|---|---|
| category page (paginated) | `GET https://www.petdirect.co.nz/c/<category>?page=N` |

Categories walked (nav-verified): `/c/dog/`, `/c/cat/`, `/c/pet-health/`,
`/c/top-picks/` (24 cards per page).

## Field mapping

| Payload | PriceObservation |
|---|---|
| `data-product-id` on `<article class="product-card">` | `product.id = pet-direct:<id>` |
| `card-image` img `alt` | `product.name` |
| first `card-price` span | current price (promo when RRP stack present) |
| `price-stack--rrp` ("why pay?") span | `price.regularCents` on sale cards |
| `<strong>` inside `product-card-name` | `product.brand` |
| first card `<img src>` | `product.images.primary` |

## Verification (2026-09-06)

`node retailers/pet-direct/collect.js --stdout --max-pages 1` produced 65
valid observations. Sample: `pet-direct:1254` "NexGard Spectra Flea Tick &
Worm Treatment Chew for Dogs" — RRP $29.99 mapped to regularCents, sale
$22.49 mapped to promoCents, brand NexGard.

## Quirks

- Discounted cards render the RRP with nested spans
  (`card-price">$<span>39.99</span>`), which the was-price regex handles.
- The store also runs an Algolia search dropdown, but the SSR category
  pages made it unnecessary for the catalog walk.
