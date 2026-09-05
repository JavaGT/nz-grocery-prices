# Commonsense Organics — campaign adapter

- **retailer id:** `commonsense-organics` · **category:** organic grocery
- **platform:** SilverStripe — sitemap + JSON-LD product pages (jsonld-pdp family)
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `commonsense-organics:online`

## API discovery

Each `/shop-online/…` leaf page IS a product page with schema.org JSON-LD
(`sku`, `brand.name`, `offers.price` NZD). The SilverStripe sitemap
parts enumerate every leaf.

| What | Endpoint |
|---|---|
| sitemap parts | `GET …/sitemap.xml/sitemap/SilverStripe-CMS-Model-SiteTree/{1,2}` |
| product page | `GET https://commonsenseorganics.co.nz/shop-online/<path>/` |

## Verification

Budgeted run (`--page-size 5 --max-pages 1`) produced 5 valid
observations; sample `commonsense-organics:5836` "Weleda Calendula Nappy
Change Cream" $19.99, brand Weleda.

## Quirks

- The `/shop-online` tree mixes product leaves and nav branches; pages
  without JSON-LD Product nodes are dropped by the mapping.
- One request per product — keep the budget tight.
