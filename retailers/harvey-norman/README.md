# Harvey Norman NZ — campaign adapter

- **retailer id:** `harvey-norman` · **category:** electronics/appliances
- **platform:** CS-Cart (SSR tiles)
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `harvey-norman:online`

## API discovery

| category page (server-paginated) | `GET origin/<category>/?page=N` (48/page, trailing slash required) |

## Field mapping

Tiles: `a.product-title.product_link_<id>` anchor + split `price-num` spans (`$` + amount). CS-Cart returns an AJAX JSON wrapper when the request Accept header advertises application/json — the shared getText path avoids that. Verified 2026-09-06: 95 observations page 1.

## Verification

```sh
node retailers/harvey-norman/collect.js --stdout --max-pages 1
```

## Quirks

- Listing tiles show whole-dollar amounts only (rounded display) and no was-price.
- Some category slugs 500 (audio) — skipped gracefully.
