# Briscoes — campaign adapter

- **retailer id:** `briscoes` · **category:** homeware
- **platform:** Magento 2 GraphQL (shared backend with Rebel Sport)
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `briscoes:online`

## API discovery

| category tree + products | POST `/graphql` (same queries as rebel-sport, default store view) |

## Field mapping

Default store view is `briscoes`. Verified 2026-09-06: 663 observations page-1 walk; sample `briscoes:4462106` "Annabel Langbein Home Collection Terra Bowl 14cm Natural" was $16.99 → $10.19.

## Verification

```sh
node retailers/briscoes/collect.js --stdout --max-pages 1
```

## Quirks

- Some GraphQL items expose 0 prices (placeholder entries) and are filtered.
