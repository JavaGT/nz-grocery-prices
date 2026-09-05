# Book Hound — campaign adapter

- **retailer id:** `book-hound` · **category:** second-hand & discount books
- **platform:** Circlesoft bookshop software (same family as Wardini)
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `book-hound:online`

## API discovery notes

The homepage carousels are server-rendered with fully attributed book
tiles: `data-barcode` (ISBN-13), `data-product-name`, `data-product-price`
(NZD), and `data-product-category`. The full catalog browse lives behind
their search app (no open listing URL found), so the homepage carousels
(~180 books) are the collection source.

## Field mapping

| Payload | PriceObservation |
|---|---|
| `data-barcode` (ISBN-13) | `product.id = book-hound:<isbn>` and `product.gtin` |
| `data-product-name` | `product.name` |
| `data-product-price` | `price.regularCents` |
| `data-product-category` | `product.categories` |
| product link `/p/<slug>` | `source.url` |

## Verification (2026-09-06)

`node retailers/book-hound/collect.js --stdout` produced 179 valid
observations. Sample: `book-hound:9781804548417` "White Cat, Black Dog"
$17.00 NZD.

## Quirks

- Single-page source (homepage carousels); the deep catalog requires
  their search app.
- Same Circlesoft tile schema as Wardini — the two adapters share the
  profile shape.
