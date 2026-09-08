# Storefront CMS platform families (`retailers/_lib`)

How the storefront-CMS campaign families talk to retailer platforms:
Shopify, Magento 2 GraphQL, Salesforce Commerce Cloud (SFCC) updategrid,
WooCommerce Store API, and the server-rendered HTML grid fallback. Sibling
docs: search/discovery adapters in `platform-search.md`, transport and
pipeline contract in `shared-transport.md`, Foodstuffs in `foodstuffs.md`.

Every family maps payloads to the canonical PriceObservation through
`retailers/_lib/observation.js` `buildObservation`; tests validate emitted
observations with `parseObservation` (`src/domain/observation.js`).

## Who uses what (imports of `_lib/<name>.js` across `retailers/*/index.js`, 2026-09-07)

| Family | Lib | Retailers | Examples |
| --- | --- | --- | --- |
| Shopify storefront JSON | `shopify.js` | 454 | `endemicworld`, `tin-shed`, `kathmandu` |
| HTML grid fallback | `html-grid.js` | 16 | `hunting-fishing`, `pbtech`, `harvey-norman`, `animates` |
| WooCommerce Store API | `woocommerce.js` | 9 | `winebox`, `vino-fino`, `the-good-wine-co`, `scorpio-books` |
| Magento 2 GraphQL | `magento-graphql.js` | 2 | `briscoes`, `rebel-sport` (shared backend) |
| SFCC updategrid | `sfcc-updategrid.js` | 1 | `noel-leeming` |

## Transport (how each family gets HTTP)

Details and failure semantics live in `shared-transport.md`; cited here so
each family's error behavior is traceable.

| Family | Transport | Cite |
| --- | --- | --- |
| shopify | `getJson` (`http.js:28`) | `shopify.js:13`, `104`, `129` |
| magento-graphql | `fetchWithRetry` direct, POST | `magento-graphql.js:12`, `107` |
| sfcc-updategrid | `getText` (`http.js:41`) or `curlGetText` (`curl-transport.js:47`) | `sfcc-updategrid.js:12-13`, `74-88` |
| woocommerce | `getJson` (`http.js:28`) | `woocommerce.js:10`, `92` |
| html-grid | `getText` (`http.js:41`) | `html-grid.js:13`, `201` |

All clients accept `{ fetch, headers, timeout, retry }` and default to
`globalThis.fetch`; tests always inject a stub `fetch`. `fetchWithRetry`
supplies timeouts (AbortController), retry on 429/502/503/504 honoring
`Retry-After`, and hardened JSON parsing
(`src/adapters/fetch-with-retry.js:88-90`, `102-114`, `190-196`).
Note: retry applies to GET only — the Magento POST is never auto-retried
(`fetch-with-retry.js:161`).

---

## Shopify (`retailers/_lib/shopify.js`)

Shopify storefronts expose the published catalog as public JSON, no auth
(`shopify.js:1-11`).

### Endpoints

| Purpose | Method | URL pattern | Query params |
| --- | --- | --- | --- |
| Full catalog page | GET | `{origin}/products.json` | `limit` (default 250), `page` (1-based) (`shopify.js:100-116`) |
| One collection page | GET | `{origin}/collections/<handle>/products.json` | same; handle `encodeURIComponent`-encoded (`shopify.js:118-123`) |
| Collection index (discovery) | GET | `{origin}/collections.json` | `limit`, `page` (`shopify.js:125-136`) |

`DEFAULT_LIMIT = 250` matches Shopify's documented per-page cap
(`shopify.js:16`).

### Auth/headers
None. `BROWSER_UA` default (`shopify.js:80`, string at `http.js:11`); the
`accept: application/json` header is forced by `getJson` (`http.js:32`).

### Config → request
A retailer exports `createClient(options)` returning a
`ShopifyCatalogClient({ slug, origin, scopeName, ... })` (example:
`retailers/endemicworld/index.js`). `timeout` defaults to 15s and `retry`
passes through to `fetchWithRetry` (`shopify.js:82-83`).

### Response fields consumed
`products.json` → `{ products: Product[] }`; the array is extracted
tolerantly (`parseShopifyProducts`, `shopify.js:19-21`). Per product:
`id:number`, `handle:string`, `title:string`, `vendor:string`,
`product_type?:string`, `tags?:string[]`, `images[].src:string`,
`variants[]: { id:number, price:string, compare_at_price?:string,
barcode?:string }`. Prices are decimal dollar strings (`"29.90"`); the
mapping (`toShopifyObservations`, `shopify.js:29-69`) uses the live price
as authoritative, treats `compare_at_price` as a was-price only when it
parses and exceeds the live price (44-49), accepts `barcode` as GTIN when
it is 6-14 digits (23-26), and builds the PDP url as
`{origin}/products/<handle>` (32). Categories = `product_type` + first 3
tags (34-37).

### Pagination / rate limiting
`collectProducts` walks `page=1..` until the first short page
(`products.length < pageSize`, `shopify.js:150`), deduping by product id
(147-149). No client-side throttling; 429s are retried with `Retry-After`
via the shared transport.

### Failure modes
- Shops that disable `/products.json` (redirects/apps): list requests fail
  via `assertOk` errors; the documented fallback is the collection paths
  (`listCollections`/`listCategory`, `shopify.js:8-10`). Per-retailer
  verdicts live in `retailers/<slug>/README.md`.
- Non-JSON 200 bodies (WAF challenges) fail with a context error naming
  the operation, status, content-type, and body prefix
  (`fetch-with-retry.js:55-86`).
- Junk variants (zero/unparseable price) are skipped; valid siblings
  survive (`shopify.js:44-49`, test `shopify.test.js:77-88`).
- Timeouts abort as `TimeoutError` after 15s default.

---

## Magento 2 GraphQL (`retailers/_lib/magento-graphql.js`)

NZ Magento storefronts with a working `POST /graphql` endpoint. Multi-store
backends select a store view with a `Store` header — Briscoes and Rebel
Sport share one backend (`magento-graphql.js:1-9`,
`retailers/briscoes/index.js:3-5`).

### Endpoints

| Purpose | Method | URL pattern | Body |
| --- | --- | --- | --- |
| Category tree (discovery) | POST | `{origin}/graphql` | `{ query: CATEGORY_TREE_QUERY }` (`magento-graphql.js:15-24`) |
| Products by category | POST | `{origin}/graphql` | `{ query, variables: { categoryId, page, pageSize } }` (`magento-graphql.js:26-44`) |

The products query is
`products(filter: { category_id: { eq: $categoryId } }, currentPage: $page,
pageSize: $pageSize, sort: { name: ASC })` requesting `total_count` and
per-item `id, sku, name, url_key, price_range { minimum_price { final_price
{ value } regular_price { value } discount { amount_off percent_off } } },
small_image { url }`. `discount` is fetched but unused — promo derivation
compares final vs regular (`mapMagentoItem`, `magento-graphql.js:47-64`).

### Auth/headers
No auth. `content-type: application/json`, `BROWSER_UA` default, and
`store: <storeCode>` when the retailer configures one
(`magento-graphql.js:82-87`).

### Config → request
`MagentoGraphqlClient({ slug, origin, storeCode, categories: [urlKey,...],
pageSize })`; `pageSize` defaults to 100, `timeout` to 25s, and `mapItem`
is an overridable mapping seam (`magento-graphql.js:66-91`). `categories`
are category url_keys from the retailer module (e.g. `briscoes` CATEGORIES).

### Response fields consumed
Tree: `data.categories.items[].children[]` as
`{ id:number, url_key:string, name:string, product_count:number }`
(flattened one level, `magento-graphql.js:128-139`). Products:
`total_count:number` and `items[]` mapped to observations — current price =
`final_price.value`, regular = `regular_price.value` (dollars → cents via
`toCents`), promo only when regular > current (`47-64`), PDP url =
`{origin}/{url_key}` (57). Items without id/name/positive final price are
dropped (50).

### Pagination / rate limiting
`collectProducts` resolves each configured url_key to its numeric id via
the tree (160), then pages `currentPage=1..maxPages` (default 50) until
`collected >= min(product_count, maxPages * pageSize)` (170) or a page
yields neither fresh ids nor items (192). Cross-category dedupe by
`item.id` (180-182). No client-side throttling (and POSTs are not
retried — see Transport).

### Failure modes
- HTTP non-OK: `graphql <slug> failed: <status> <statusText>` (116).
- HTTP 200 with GraphQL `errors[]`: thrown with the joined messages
  (122-124).
- HTTP 200 with an HTML/WAF body: a clear parse error naming the retailer,
  status, and content-type via `parseJsonResponse` (hardened 2026-09-07,
  `magento-graphql.js:118-121`; `fetch-with-retry.js:55-86`).
- A failing page aborts only that category (`console.error` + break,
  175-178); an unknown url_key is skipped with `console.error` (165-168).
- A malformed category tree (null roots, null/junk `children` entries) is
  filtered during tree flattening (hardened 2026-09-07) instead of crashing
  the url_key map.
- Hanging requests abort as `TimeoutError` after 25s
  (`magento-graphql.test.js:32-43`).

---

## SFCC updategrid (`retailers/_lib/sfcc-updategrid.js`)

Classic Salesforce Commerce Cloud storefronts render category grids
server-side; Noel Leeming's `Search-UpdateGrid` 301s to the same
`/search/updategrid` endpoint The Warehouse uses, with the identical tile
payload, so this family delegates parsing to the proven warehouse
transformers instead of re-implementing markup parsing
(`sfcc-updategrid.js:1-18`, `retailers/noel-leeming/index.js:6-8`).

Related but distinct: **Mitre 10 is not SFCC** — it is SAP Commerce (OCC
REST API on `ccapi.mitre10.co.nz` plus 83 sitemap shards for discovery,
`retailers/mitre-10/index.js:1-18`), tested in
`test/retailers/mitre-10.test.js`.

### Endpoint

| Purpose | Method | URL pattern | Query params |
| --- | --- | --- | --- |
| Category grid page | GET | `{origin}{gridPath}` (default `/search/updategrid`) | `cgid=<category id>`, `start=<offset>` = `(page-1)*pageSize`, `sz=<pageSize>` (`sfcc-updategrid.js:37`, `69-73`) |

### Auth/headers
No auth. `accept: text/html,application/xhtml+xml`,
`referer: {origin}/`, UA only when configured (undefined values are
dropped before send) (`sfcc-updategrid.js:45-50`, `http.js:20-22`).

### Config → request
`SfccUpdateGridClient({ slug, origin, categories: ["cgid",...],
pageSize })`; `pageSize` defaults to 48, `timeout` to 20s, `gridPath` is
overridable (`sfcc-updategrid.js:26-54`). **Transport choice is a
retailer-facing behavior**: the default transport is `curl` via `execFile`
(anti-bot TLS fingerprinting — Noel Leeming 403s Node fetch); injecting
`fetch` opts into the fetch transport, which is what tests do
(`43`, `74-88`).

### Response fields consumed (HTML)
Tiles are `<div class="product-tile" data-pid=... data-gtm-product='{"id":...}'>`;
the `data-gtm-product` JSON carries the consumed fields — `id`, `name`,
`brand`, `productEAN` (→ GTIN), `price`, `productThenPrice`
(`test/retailers/sfcc-updategrid.test.js:11-39`). Parsing, observation
mapping, and the declared-total reader (`totalGridItems`, from the
"1 – 24 of 96 products" line) come from `src/adapters/warehouse.js`
(`sfcc-updategrid.js:14-24`).

### Pagination / rate limiting
Per cgid: `start = 0, 48, 96, ...` until a page contributes no fresh
product ids, or `page * pageSize >= declared total` (guards grids that
loop their tail) (`sfcc-updategrid.js:118-121`; `maxPages` default 100). Cross-category
dedupe by product id (97, 112-117). No client-side throttling.

### Failure modes
- Page-1 failure for a category: skip that category with `console.error`
  (104-107); a later-page failure aborts the walk (108).
- Non-2xx: `assertOk`/curl errors naming the operation.
- A 200 HTML body that parses to zero tiles is treated as an empty page
  and silently ends the category — by design for grids that end with
  markup-only pages.
- Timeouts: 20s, surfaced as curl timeout or `TimeoutError`.

---

## WooCommerce Store API (`retailers/_lib/woocommerce.js`)

WooCommerce sites with the public read-only Store API enabled
(`woocommerce.js:1-8`).

### Endpoint

| Purpose | Method | URL pattern | Query params |
| --- | --- | --- | --- |
| Products page | GET | `{origin}{apiPath}` (default `/wp-json/wc/store/v1/products`) | `per_page` (default 50), `page` (1-based), optional `category=<id>` (`woocommerce.js:65-66`, `87-91`) |

### Auth/headers
None (public read-only API). `accept: application/json`
(`woocommerce.js:68`).

### Config → request
`WooStoreClient({ slug, origin, scopeName, pageSize })`; `timeout` 25s,
`apiPath` and `mapItem` overridable (`woocommerce.js:57-75`; example
`retailers/winebox/index.js`).

### Response fields consumed
A JSON **array** of products (`parseWooProducts`, `woocommerce.js:13-25`):
`id:number`, `name:string`, `permalink:string`,
`prices { price, regular_price, sale_price, currency_minor_unit? }` —
minor-unit strings (`"2499"` = $24.99, scaled by `currency_minor_unit`),
`images[].src`, `short_description?:string`. Promo only when
`sale_price < regular_price` (`mapWooProduct`, `woocommerce.js:31-54`);
items without id/name/positive price are dropped (35).

### Pagination / rate limiting
`collectProducts` pages 1..maxPages (default 20, `woocommerce.js:102`) until
a page is short (`items.length < pageSize`, 132) or adds nothing new (133);
dedupe by `retailerProductId` (123-125). No client-side throttling.

### Failure modes
- Page-1 failure degrades to partial results with `console.error` (112-116)
  — a whole-retailer outage yields an empty collect, not a crash; later
  failures rethrow (117).
- Non-JSON 200 bodies fail with a context error naming `woo <slug> p<n>`
  (`http.js:38`, `fetch-with-retry.js:55-86`).
- A 200 JSON *object* — WP REST error bodies are objects, e.g.
  `{"code":"rest_no_route",...}` — fails with a named TypeError from
  `parseWooProducts` (`woocommerce.js:13-25`) instead of an "items is not
  iterable" crash. Page-walk semantics match network failures: page 1 logs
  and returns empty (retailer unreachable); later pages rethrow so the
  walk stops loudly. Tests: `test/retailers/woocommerce.test.js`.

---

## HTML grid fallback (`retailers/_lib/html-grid.js`)

For storefronts that expose no usable structured API but server-render
category pages as product tiles — e.g. Hunting & Fishing's Magento whose
GraphQL answers `storeConfig` with an empty products scope
(`html-grid.js:1-11`, `retailers/hunting-fishing/index.js:3-6`). Theme
markup differs per retailer, so tile extraction is driven by per-retailer
regex **profiles** (configuration, not code; profile contract documented at
`html-grid.js:73-84`).

### Endpoints

| Purpose | Method | URL pattern | Params |
| --- | --- | --- | --- |
| Category grid page ("page" mode, Magento default) | GET | `{origin}/<category-path>` | `?<pageParam>=<page>` (`pageParam` default `p`) appended, or `&` if the category already has a query (`html-grid.js:163`, `197-199`) |
| Category grid page ("offset" mode, SFCC-style) | GET | `{origin}/<category-path>` | `start=<offset>&sz=<pageSize>` (`html-grid.js:164-166`, `191-195`) |

Category paths are plain retailer config strings, e.g.
`["hunting", "fishing", "camping"]` (`retailers/hunting-fishing/index.js:18`).

### Auth/headers
`BROWSER_UA` default (`html-grid.js:168`); `getText` forces
`accept: text/html,...` because some themes switch to AJAX rendering when
offered JSON (`http.js:46-48`).

### Config → request
`HtmlGridClient({ slug, origin, categories: [path,...], profile,
pagination?, pageParam?, pageSize? })`; `pageSize` 24 (offset mode),
`timeout` 20s (`html-grid.js:143-175`).

### Markup parsed (profile contract)
- `tileStart` (global RegExp) slices the HTML into tile strings
  (`extractTileSlices`, `html-grid.js:44-49`).
- `id`: ordered regex fallbacks — required retailerProductId (86-87).
- `name`: regex fallbacks or the tile anchor's `title` attribute,
  HTML-entity-decoded (98-102); a profile with no `name` regexes relies on
  the title alone. PB Tech's split h2+h3 name is joined via
  the `joinName` flag (91-97). Named and numeric (`&#123;`, `&#x1F600;`)
  entities are decoded (24-41).
- `linkClass`: the anchor class carrying `href` (63-66, 88-89).
- `finalPrice` / `wasPrice` / `memberPrice`: price captures
  (`"37.99"`/`"$37.99"`) from e.g. Magento `priceBox`
  `data-price-type`/`data-price-amount` attributes (103-108).
- Optional `brand` capture and `image: true` (prefers lazy-load
  `data-src`, never emits `data:` placeholder URIs, 118-127).
- A tile without id, name, or parseable final price is dropped (109).

### Pagination / rate limiting
Per category, page 1..maxPages (default 50) until a page yields no new
tile ids (240); dedupe by tile id across categories (231-236). Tile urls
are absolutized, or built from a `urlFromId` template (250-256); the
category label for `product.categories` derives from the path (214-217).
No client-side throttling.

### Failure modes
- A malformed profile (missing `id` regex list, or a `tileStart` that is
  not a global RegExp) fails at construction with a named `TypeError`
  (hardened 2026-09-07) instead of a confusing mid-walk iteration error.
- Dead/renamed category: page-1 failure skips the category with
  `console.error`; later failures abort the walk (222-228).
- Garbled numeric entities (code points above U+10FFFF) stay literal
  instead of `RangeError`-crashing the walk (hardened 2026-09-07;
  `html-grid.js:16-41`).
- Non-2xx/WAF handled by the shared `getText` seams.
