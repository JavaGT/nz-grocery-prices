# Super Liquor — campaign adapter

- **retailer id:** `super-liquor` · **category:** liquor
- **platform:** nopCommerce storefront + public Algolia index
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `super-liquor:online` (national online pricing)

## API discovery notes

- The storefront bundle initializes Algolia with
  `algoliasearch("81Y7HZ6N3A","2b092b5b231305252cb9275a0e4ddea6")` and index
  `Products` — a search-only key, no auth beyond the headers.
- The index has Algolia's `paginationLimitedTo` (≈1000): plain empty-query
  pagination stops after the first 1000 records. The adapter therefore
  slices the walk over the numeric `Id` field in ranges of 500
  (`numericFilters=Id>N,Id<=N+500`), which recovers the whole catalog.

## Endpoints used

| What | Endpoint |
|---|---|
| catalog walk / search | `GET https://81y7hz6n3a-dsn.algolia.net/1/indexes/Products?query=&hitsPerPage=500&page=N&numericFilters=…` |

Headers: `x-algolia-application-id`, `x-algolia-api-key`.

## Field mapping

| Payload | PriceObservation |
|---|---|
| `Id` (numeric) | `product.id = super-liquor:<Id>` |
| `Name` | `product.name` |
| `ProductPrice.PriceValue` | `price.regularCents` |
| `ProductPrice.OldPriceValue` (when set) | `price.promoCents` |
| `Sku` (digits, 6–14) | `product.gtin` (barcode) |
| `PictureModels[0].ImageUrl` | `product.images.primary` |
| `SeName` | `source.url = https://www.superliquor.co.nz/<SeName>` |

## Verification (2026-09-06)

`node retailers/super-liquor/collect.js --stdout` walked the entire index:
**7,715 unique valid observations** (of 7,716 indexed; one has no price).
Sample: `super-liquor:6852` "Jura Journey To Jura 3x50ml" $51.99,
`super-liquor:9999` "Penfolds Bin 407 Cabernet Sauvignon 2023 750ml"
$139.99 gtin 9310297052134.

## Quirks

- `OldPriceValue` was null across the walk, so promotions are not visible
  through the index today; the mapping supports them if the retailer
  enables was-prices.
- One product (Id 9999-range entry "Penfolds…") has price 139.99 with a
  `DisableBuyButton` flag — still a valid listed price.
