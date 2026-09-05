# Liquorland — campaign adapter

- **retailer id:** `liquorland` · **category:** liquor
- **platform:** custom (window.category JSON)
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `liquorland:online`

## API discovery

| category page (server-paginated) | `GET origin/<category>?p=N` (24 items/page) |

## Field mapping

Category pages embed the full payload in `window.category = { ...{...} }` (JS object spread — the parser handles it). Fields: `productid`, `description`, `label` (brand), `stylecolour.urlkey`, `stylecolour.variants[].unitprice / originalunitprice`, `images[].src`.
Verified 2026-09-06: 897 observations across wine/beer/spirits/liqueurs/cider; sample `liquorland:125404` "The People's Rose 750ml" was $14.99 → now $12.99.

## Verification

```sh
node retailers/liquorland/collect.js --stdout --max-pages 1
```

## Quirks

- Categories that 404 (rtds, non-alcoholic) are skipped with a warning — check nav for real slugs.
