# Whitcoulls — campaign adapter

- **retailer id:** `whitcoulls` · **category:** books/stationery
- **platform:** eStar (window.category JSON)
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `whitcoulls:online`

## API discovery

| category page (page 1 only) | `GET origin/<category>` |

## Field mapping

Same eStar platform as Baby Factory; richer items (`barcode`, `author`, `pricedata`). Verified 2026-09-06: 96 observations across books/art-craft/toys/stationery/games-puzzles.

## Verification

```sh
node retailers/whitcoulls/collect.js --stdout --max-pages 1
```

## Quirks

- Page-1-only catalog view (client-side pagination not yet implemented).
