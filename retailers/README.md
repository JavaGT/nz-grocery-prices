# NZ retailer scraper campaign — 50 retailers

Goal: price & product scrapers for 50 major New Zealand retailers, each in
its own subfolder (`retailers/<slug>/`), built on the retailer's own
web/mobile APIs, emitting the repo's canonical `PriceObservation` records.

**Status vocabulary**

- *existing* — predates the campaign, lives in `src/adapters/` + `scripts/`
- *implemented* — adapter in `retailers/<slug>/`, live-verified (see its README)
- *planned* — locked target for the campaign's 50
- *backup* — swap-in candidate if a planned retailer proves inaccessible
- *blocked* — probed and inaccessible (evidence in the table)

The 5 pre-existing adapters count toward the 50 (they cover woolworths,
paknsave, newworld, freshchoice, warehouse with full collectors already wired
into the nightly breadth pipeline).

## The 50

| # | Retailer | Slug | Category | Platform / API | Status |
|---|---|---|---|---|---|
| 1 | Woolworths NZ | `woolworths` | grocery | web API + cookie session | existing — `src/adapters/woolworths.js` |
| 2 | PAK'nSAVE | `paknsave` | grocery | Foodstuffs mobile API | existing — `src/adapters/foodstuffs.js` |
| 3 | New World | `newworld` | grocery | Foodstuffs mobile API | existing — `src/adapters/foodstuffs.js` |
| 4 | FreshChoice | `freshchoice` | grocery | storefront JSON API | existing — `src/adapters/freshchoice.js` |
| 5 | The Warehouse | `warehouse` | dept store | SFCC `updategrid` (curl transport) | existing — `src/adapters/warehouse.js` |
| 6 | HealthPost | `healthpost` | pharmacy/health | Shopify products.json | implemented 2026-09-06 |
| 7 | GoodFor | `goodfor` | wholefoods | Shopify products.json | implemented 2026-09-06 |
| 8 | Huckleberry | `huckleberry` | organic grocery | Shopify products.json | implemented 2026-09-06 |
| 9 | Bargain Chemist | `bargain-chemist` | pharmacy | Shopify products.json | implemented 2026-09-06 |
| 10 | Health 2000 | `health2000` | natural health | Shopify products.json | implemented 2026-09-06 |
| 11 | Net Pharmacy | `net-pharmacy` | pharmacy | Shopify products.json | implemented 2026-09-06 |
| 12 | Unichem | `unichem` | pharmacy | Shopify products.json | implemented 2026-09-06 |
| 13 | JB Hi-Fi NZ | `jb-hifi` | electronics | Shopify products.json | implemented 2026-09-06 |
| 14 | Life Pharmacy | `life-pharmacy` | pharmacy | Shopify products.json | implemented 2026-09-06 |
| 15 | Smiths City | `smiths-city` | appliances | Shopify products.json | implemented 2026-09-06 |
| 16 | Playtech | `playtech` | PC hardware | Shopify products.json | implemented 2026-09-06 |
| 17 | Bed Bath & Beyond | `bed-bath-beyond` | homeware | Shopify products.json | implemented 2026-09-06 |
| 18 | Computer Lounge | `computer-lounge` | PC hardware | Shopify products.json | implemented 2026-09-06 |
| 19 | Kathmandu | `kathmandu` | outdoor | Shopify products.json | implemented 2026-09-06 |
| 20 | Shoe Clinic | `shoe-clinic` | footwear | Shopify products.json | implemented 2026-09-06 |
| 21 | Babycity | `babycity` | baby | custom | planned |
| 22 | Kings Plant Barn | `kings-plant-barn` | garden | custom | planned |
| 23 | Oderings | `oderings` | garden | custom | planned |
| 24 | Commonsense Organics | `commonsense-organics` | organic grocery | probe (custom) | planned |
| 25 | Bin Inn | `bin-inn` | bulk foods | probe (custom) | planned |
| 26 | Liquorland | `liquorland` | liquor | window.category JSON (?p=N) | implemented 2026-09-06 |
| 27 | The Bottle-O | `the-bottle-o` | liquor | Rails SSR talker tiles | implemented 2026-09-06 |
| 28 | Super Liquor | `super-liquor` | liquor | Algolia index (Id-sliced walk) | implemented 2026-09-06 |
| 29 | Chemist Warehouse NZ | `chemist-warehouse` | pharmacy | probe (custom, heavy JS) | planned |
| 30 | Kmart NZ | `kmart` | dept store | Next.js + custom API | planned |
| 31 | Farmers | `farmers` | dept store | probe (custom) | planned |
| 32 | PB Tech | `pbtech` | electronics | probe (custom) | planned |
| 33 | Noel Leeming | `noel-leeming` | electronics | SFCC updategrid (curl transport) | implemented 2026-09-06 |
| 34 | Harvey Norman NZ | `harvey-norman` | electronics | CS-Cart SSR tiles | implemented 2026-09-06 |
| 35 | Mitre 10 | `mitre-10` | hardware | SAP Commerce OCC + sitemap shards | implemented 2026-09-06 |
| 36 | Bunnings NZ | `bunnings` | hardware | Next.js + custom API | planned |
| 37 | Briscoes | `briscoes` | homeware | Magento GraphQL (shared w/ Rebel) | implemented 2026-09-06 |
| 38 | Rebel Sport | `rebel-sport` | sports | Magento GraphQL (Store: rebelsport) | implemented 2026-09-06 |
| 39 | Hunting & Fishing | `hunting-fishing` | outdoor | Magento HTML grids (GraphQL dead) | implemented 2026-09-06 |
| 40 | Macpac | `macpac` | outdoor | SFCC HTML grids (offset paging) | implemented 2026-09-06 |
| 41 | Supercheap Auto NZ | `supercheap-auto` | auto parts | SFCC HTML grids (offset paging) | implemented 2026-09-06 |
| 42 | Glassons | `glassons` | apparel | probe (custom) | planned |
| 43 | Animates | `animates` | pet supplies | Magento HTML grids | implemented 2026-09-06 |
| 44 | Postie | `postie` | apparel | probe (custom) | planned |
| 45 | Number One Shoes | `number-one-shoes` | footwear | probe (custom) | planned |
| 46 | Paper Plus | `paper-plus` | books/stationery | ASP.NET SSR tiles (tracking attrs) | implemented 2026-09-06 |
| 47 | Whitcoulls | `whitcoulls` | books/stationery | eStar window.category JSON | implemented 2026-09-06 |
| 48 | OfficeMax NZ | `officemax` | office supplies | probe (custom) | planned |
| 49 | Baby Factory | `baby-factory` | baby | eStar window.category JSON | implemented 2026-09-06 |
| 50 | Petdirect | `pet-direct` | pet supplies | BigCommerce Stencil HTML cards | implemented 2026-09-06 |

## Backups (swap in if a planned retailer proves inaccessible)

| Retailer | Domain | Platform / note |
|---|---|---|
| Hallenstein Brothers | hallensteins.co.nz | custom/headless; /graphql 301s to .com 404, deep links redirect — needs browser-level capture |
| The Sleep Store | thesleepstore.co.nz | Shopify (products.json blocked) |
| Merchant 1948 | overlandfootwear.co.nz | Shopify (products.json blocked) |
| Spotlight | spotlight.co.nz | DNS/dead domain — find real domain |
| Mighty Ape | mightyape.co.nz | 403 bot-block on homepage (Cloudflare) |
| Warehouse Stationery | warehousestationery.co.nz | 403 bot-block (Cloudflare) |
| Repco NZ | repco.co.nz | 403 bot-block (Cloudflare) |
| Pharmacy Direct | pharmacydirect.co.nz | 403 bot-block (Cloudflare) |

## Blocked during the campaign (probe evidence)

- **Four Square** (foursquare.co.nz) — Next.js storefront, no discoverable
  product API in page source; the Foodstuffs NI mobile API
  (api-prod.prod.fsniwaikato.kiwi) served only 150 MNW stores for every
  banner value probed (PNS/FS/FOURSQUARE with a fresh guest token,
  2026-09-06). Needs browser-level capture.
- **Gilmours** (gilmours.co.nz) — B2B wholesale storefront, no public
  product API found; wholesale pricing is likely login-gated.
- **Moore Wilson's** (moorewilsons.co.nz) — headless Shopify Oxygen:
  /products.json, /collections/*/products.json and /search/suggest.json all
  return the Hydrogen app shell. Needs browser-level capture.

## Excluded after probing

- **Kitchen Things** — site live but title says "Receivership"; not a going
  retail target.
- **1-day.co.nz, Torpedo7, TheMarket** — closed retail brands.
- **Fuel boards (Z, Gull, Waitomo, Allied)** — price-only, no product
  catalog; out of scope for the product+price scraper shape.

## Shared machinery (`retailers/_lib/`)

- `observation.js` — `buildObservation` (canonical `PriceObservation` from
  one source), price parsing (`toCents`, `minorUnitsToCents`), promotion
  derivation (`promotionFor`)
- `http.js` — hardened `getJson`/`getText` on top of
  `src/adapters/fetch-with-retry.js` (retries, timeouts, body cap)
- `shopify.js` — `ShopifyCatalogClient` + pure transforms
  (`parseShopifyProducts`, `toShopifyObservations`)
- `runner.js` — the per-retailer `collect.js` CLI flow (validates every
  observation with `parseObservation`, writes JSONL only to explicit
  `--out` paths, refuses the live archive via `assertNotLiveArchive`)

## Rules of the campaign

1. Adapters are **zero-dependency ESM Node**, reusing `_lib` and the
   existing `src/adapters` seams; no Playwright/SDK in shipped code.
2. Every emitted record must pass `parseObservation` (validated by the
   runner and by tests).
3. Each retailer folder documents its endpoints, mapping, verification
   evidence, and quirks in its own `README.md`.
4. Product ids are `<slug>:<retailerProductId>`; store ids are
   `<slug>:<scope>`; `store.retailer` is the slug.
5. Campaign collectors never touch `data/prices.jsonl` (runner enforces).
6. `test/retailers/retailer-registry.test.js` gates every folder's shape
   and, once 50 adapters exist, the campaign total.

Progress: **36 / 50** (5 existing + 31 implemented).
