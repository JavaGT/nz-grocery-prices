# Rebel Sport — campaign adapter

- **retailer id:** `rebel-sport` · **category:** sporting goods
- **platform:** Magento 2 GraphQL (shared backend with Briscoes)
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `rebel-sport:online`

## API discovery

| category tree | POST `/graphql` `{ categories { items { children { id url_key product_count } } } }` |
| products by category | POST `/graphql` `products(filter:{category_id:{eq:$id}}, currentPage, pageSize)` |

## Field mapping

The `Store: rebelsport` header selects the Rebel store view on the shared backend. Verified 2026-09-06: 701 observations page-1 walk (new-in/clothing/footwear/fangear/equipment/outdoors/kids/mens/womens/sale); sample `rebel-sport:4623650` "2XU Run Belt" was $59.99 → $50.99.

## Verification

```sh
node retailers/rebel-sport/collect.js --stdout --max-pages 1
```

## Quirks

- `storeConfig` without the Store header reports the briscoes store view — always send the header.
