# Baby Factory — campaign adapter

- **retailer id:** `baby-factory` · **category:** baby
- **platform:** eStar (window.category JSON)
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `baby-factory:online`

## API discovery

| category page (page 1 only) | `GET origin/<category>` |

## Field mapping

eStar pages embed `window.category` JSON (page 1 only; deeper pages load client-side via a datakey XHR). Fields: `productid`, `description`, `label` (brand), `stylecolour.variants[].unitprice / baseunitprice`.
Verified 2026-09-06: 50 observations across 4 working top-level categories.

## Verification

```sh
node retailers/baby-factory/collect.js --stdout --max-pages 1
```

## Quirks

- Page-1-only catalog view (client-side pagination not yet implemented).
- Wrong category slugs 404 and are skipped.
