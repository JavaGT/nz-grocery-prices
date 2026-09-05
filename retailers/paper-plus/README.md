# Paper Plus — campaign adapter

- **retailer id:** `paper-plus` · **category:** books/stationery
- **platform:** custom ASP.NET (SSR tiles)
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `paper-plus:online`

## API discovery

| category page (server-paginated) | `GET origin/shop/<category>?page=N` (12/page) |

## Field mapping

Tiles carry clean tracking attributes: `data-productid`, `data-name`, `data-brand`, `data-url`, `data-price` (hidden js-product-data span). Was/now divs (`class="was"` / `class="now"`) mark specials. Verified 2026-09-06: 24 observations page 1.

## Verification

```sh
node retailers/paper-plus/collect.js --stdout --max-pages 1
```

## Quirks

- Tile container is an <article> with data-productid; the inner div.item the agent report mentioned is nested.
- `/shop/toys` 404s — dead category, skipped.
