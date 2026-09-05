# Moore Wilson's — campaign adapter

- **retailer id:** `moore-wilsons` · **category:** grocery (Wellington)
- **platform:** headless Shopify Hydrogen — SSR PDPs + sitemap (jsonld-pdp family)
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `moore-wilsons:online`

## API discovery notes

Classic Shopify JSON endpoints (`/products.json`, `/collections/*`,
`/search/suggest.json`) are disabled — the Hydrogen app shell answers them.
But the sitemap (`/sitemap/products/N.xml`) enumerates every product and
each SSR product page renders the price as
`<div class="product-price md"><div>NZ$36.95</div></div>` with the code in
the URL tail (`/products/203372-…`).

## Endpoints used

| What | Endpoint |
|---|---|
| product sitemap shard | `GET https://www.moorewilsons.co.nz/sitemap/products/1.xml` |
| product page | `GET https://www.moorewilsons.co.nz/products/<code>-<slug>` |

## Field mapping

| Payload | PriceObservation |
|---|---|
| URL tail code | `product.id = moore-wilsons:<code>` |
| `<title>` (prefix stripped) | `product.name` |
| `product-price` div (`NZ$36.95`) | `price.regularCents` |

## Verification (2026-09-06)

Budgeted run produced 4 valid observations; sample `moore-wilsons:203372`
"Ocean Madison Wine Glasses 6 Pack" $36.95.

## Quirks

- Cash-and-carry model: no was-price/discount markup on PDPs.
- One request per product; budget `--page-size × --max-pages`.
