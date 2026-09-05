# Number One Shoes + Hannahs — campaign adapter

- **retailer id:** `number-one-shoes` · **category:** footwear
- **platform:** Black Pepper/eStar family — `window.category` JSON in page source
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `number-one-shoes:online` (NZ, NZD)

## API discovery

Category pages embed `window.category = { ...{...} }` (locale NZ, NZD) with
server-side pagination `?p=N&s[relevance]=desc` (24 items/page). The Vue
templates with `${{ … }}` mustaches in the raw HTML are just render
templates — the JSON payload carries the real data.

Categories: `mens`, `womens`, `kids`, `clearance`.

## Verification

`node retailers/number-one-shoes/collect.js --stdout --max-pages 2`
produced 161 valid observations (4 categories × 2 pages). Sample:
`number-one-shoes:12064` "Hush Puppies Alfredo Men's Leather Loafers"
$219.99.

## Quirks

- `numberoneshoes.co.nz` 301s to `numberoneshoesandhannahs.co.nz`; the
  adapter uses the final domain.
- Barcode fields here are real EAN-13 barcodes (e.g. 24283397 is a
  8-digit EAN) — trusted at 8–14 digits.
