# Supercheap Auto New Zealand — campaign adapter

- **retailer id:** `supercheap-auto` · **category:** auto parts & accessories
- **platform:** SFCC, server-rendered category grids (`html-grid` family)
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `supercheap-auto:online` (NZ national online pricing)

## API discovery notes

- The NZ storefront lives on its own domain (`supercheapauto.co.nz`); the
  `.com.au` host only hosts the shared static library.
- `/shop/*` URLs and the demandware controllers return **410**; the working
  category URLs are plain paths (`/oils-fluids-filters/engine-oil`) with
  offset pagination `?start=N&sz=24` (24 tiles/page, server-rendered).
- Sale tiles mark "Now"/"Was" spans; every tile also embeds a
  percent-encoded GTM payload (`%22price%22%3A…`) used as a price fallback.

## Endpoints used

| What | Endpoint |
|---|---|
| category grid (offset paginated) | `GET https://www.supercheapauto.co.nz/<category>?start=N&sz=24` |

Categories walked (nav/PDP-verified): `4wd-touring`, `batteries-electrical`,
`car-care-cleaning`, `diy-car-servicing-essentials`, `oils-fluids-filters`,
`marine`, `motorcycle`, `best-sellers`, `bonus-buys`, `clearance`.

## Field mapping

| Payload | PriceObservation |
|---|---|
| `/p/<slug>/<id>.html` link | `product.id = supercheap-auto:<id>` |
| `thumb-link` title | `product.name` |
| `product-sales-price` → `the-price` | current price (promo when Was present) |
| `product-standard-price` → `the-price` | `price.regularCents` on sale tiles |
| `brand-name` h4 / GTM `item_brand` | `product.brand` |
| first tile `<img src>` | `product.images.primary` |

## Verification (2026-09-06)

`node retailers/supercheap-auto/collect.js --stdout --max-pages 1` produced
370 valid observations. Sample: `supercheap-auto:725478` "HardKorr 12V
Quick-Boil Kettle" $69.99, brand HardKorr. Clearance page cross-checked:
Now $140.00 / Was $179.99 with `discount` 39.99 in the GTM payload.

## Quirks

- The category tree is deep (`4wd-touring/4wd-recovery-gear/…`); the
  adapter walks top-level categories only — subcategory products still
  surface via pagination because SFCC grids include descendant products.
- Product URLs are relative (`/p/...`); the client resolves them against
  the NZ origin.
