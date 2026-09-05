# OfficeMax NZ — campaign adapter

- **retailer id:** `officemax` · **category:** office products
- **platform:** Commerce Vision — sitemap + JSON-LD PDPs (jsonld-pdp family)
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `officemax:online` (national online pricing)

## API discovery notes

- Category grids render client-side (Kendo + WebServicesAjax POST — no
  SSR prices, endpoint not curl-discoverable), but `Sitemap_Products.xml`
  enumerates every PDP and PDPs are server-rendered with complete
  schema.org JSON-LD (`gtin13`, `brand`, `offers.price` NZD).

## Endpoints used

| What | Endpoint |
|---|---|
| product sitemap | `GET https://www.officemax.co.nz/Sitemap_Products.xml` |
| product page | `GET https://www.officemax.co.nz/<category path>-<code>` |

## Field mapping (JSON-LD Product)

| Payload | PriceObservation |
|---|---|
| `data-product-code` / URL tail | `product.id = officemax:<code>` |
| `name` | `product.name` |
| `brand.name` | `product.brand` |
| `gtin13` (8–14 digits) | `product.gtin` |
| `offers.price` | `price.regularCents` |
| `offers.url` / PDP URL | `source.url` |

## Verification (2026-09-06)

`node retailers/officemax/collect.js --stdout --page-size 5` produced valid
observations (budget cap applies). Sample: `officemax:10118117` "BioPak
Disposable Wooden Knives 160mm, Pack of 100" $5.14, gtin 9344062017202.

## Quirks

- `price` in the JSON-LD is the GST-exclusive trade price (OfficeMax is
  B2B-oriented); the inc-GST display price lives in separate spans.
- One request per product: keep `--page-size × --max-pages` within budget.
