# The Bottle-O — campaign adapter

- **retailer id:** `the-bottle-o` · **category:** liquor
- **platform:** Ruby on Rails (SSR talker tiles)
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `the-bottle-o:online`

## API discovery

| category page (server-paginated) | `GET thebottleo.co.nz/category/<slug>?page=N` (48/page, apex domain — www 302s) |

## Field mapping

Tiles: `div.talker` with `id="line_<24-hex>"`, name in `talker__product-name`, current price in `price__sell`. Verified 2026-09-06: 148 observations across beer/wine/spirits/cider.

## Verification

```sh
node retailers/the-bottle-o/collect.js --stdout --max-pages 1
```

## Quirks

- No was-price in listing markup (discount state only via container classes); product pages carry JSON-LD if ever needed.
- robots.txt blocks named SEO/AI bots; the generic browser UA this adapter uses is fine.
