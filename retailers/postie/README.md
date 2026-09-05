# Postie — campaign adapter

- **retailer id:** `postie` · **category:** budget apparel
- **platform:** Black Pepper — `window.category` JSON in page source
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `postie:online` (NZ store view, NZD)

## API discovery

`GET https://www.postie.co.nz/<category>` embeds
`window.category = { ...{...} }` (locale "nz", NZD). Verified /womens:
524 price keys in the embedded payload.

Categories: `womens`, `mens`, `kids`, `baby`, `sleepwear`,
`underwear`, `sale-clearance`.

## Verification

276 valid observations across 7 categories; sample `postie:34805`
"Women's Long Sleeve Knit Rugby Polo" $35.00.

## Quirks

- Page-1-per-category only (deeper pages load client-side).
