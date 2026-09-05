# Icebreaker — campaign adapter

- **retailer id:** `icebreaker` · **category:** merino apparel
- **platform:** Shopify public storefront JSON
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `icebreaker:online`

## API

`GET https://www.icebreaker.com/products.json?limit=250&page=N` —
Shopify family (see `retailers/_lib/shopify.js`).

## Verification (2026-09-06)

Sample `icebreaker:43345139466275` "Men's Merino Hike+ Medium Crew
Across the Peaks Socks" — valid observation.

## Quirks

- Swaps the originally-planned Farmers row (Akamai bot-blocked).
