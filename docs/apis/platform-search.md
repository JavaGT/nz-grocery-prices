# Platform search & discovery APIs (`retailers/_lib`)

Upstream storefront search/discovery platforms used by the 500-retailer
campaign. Each adapter turns the platform's payloads into canonical
`PriceObservation` records via `buildObservation`
(`retailers/_lib/observation.js:84`) — see `docs/apis/shared-transport.md`
for the transport layer and the pipeline contract.

All HTTP goes through the shared `getJson`/`getText` seams in
`retailers/_lib/http.js` (timeouts, retry with backoff, WAF-aware JSON
errors, body cap) unless noted. Every client accepts an injectable
`fetch` for tests; tests use fixture response doubles, never live calls.

---

## Algolia — `retailers/_lib/algolia.js`

Retailers that expose their catalog through a public Algolia index
(app id + search-only key embedded in storefront JS).

**Used by:** 1 retailer — `super-liquor` (`retailers/super-liquor/index.js`).

### Endpoint & auth

- `GET https://{appId-lowercase}-dsn.algolia.net/1/indexes/{indexName}`
  (`algolia.js:89-91`), index name URL-encoded.
- Auth is **header-based, never in the URL** (`algolia.js:102-105`):
  - `x-algolia-application-id: {appId}`
  - `x-algolia-api-key: {apiKey}` (public search key from the storefront
    bundle — e.g. `super-liquor/index.js:45-46`)
- Error labels (`operation`) name slug + index + page, not credentials
  (`algolia.js:109`).

### Request params (query string, `algolia.js:94-99`)

| Param | Type | Notes |
|---|---|---|
| `query` | string | `""` browses the whole index in index order |
| `page` | integer, 0-based | |
| `hitsPerPage` | integer | default `pageSize` (constructor, default 1000; super-liquor uses 500) |
| `numericFilters` | string | e.g. `Id>0,Id<=500` — used by the slice walk |

### Consumed response fields

- `hits: array` — the only field required; missing/junk → `[]`
  (`parseAlgoliaHits`, `algolia.js:15-17`).
- `nbPages: number` — optional, default 1; ends pagination
  (`algolia.js:145`, `algolia.js:160`).
- Hit shape is retailer-specific: the client takes a per-retailer
  `mapHit(hit, store)` returning a `buildObservation` spec (or
  `undefined` to drop the hit). Hits are deduped by product id
  (`toAlgoliaObservations`, `algolia.js:23-42`). super-liquor consumes
  nopCommerce-shaped hits: `Id:number`, `objectID:string`, `Name:string`,
  `SeName:string`, `Sku:string`, `ProductPrice.PriceValue/OldPriceValue:number`,
  `PictureModels[].ImageUrl:string` (`retailers/super-liquor/index.js:26-44`).

### Pagination

- **Plain walk:** `page` increments until `hits` is empty or `page` passes
  `nbPages - 1` (`algolia.js:152-162`).
- **Slice walk** (indexes with Algolia's `paginationLimitedTo`, ~1000
  records, which hides everything past the first page(s)): when
  `sliceAttribute` names a numeric hit field, the walk slides
  `numericFilters = {attr}>{lo},{attr}<={lo+step}` windows, tracking the
  highest id seen and stopping after 3 consecutive empty slices
  (`algolia.js:113-151`). super-liquor slices `Id` in steps of 500
  (`retailers/super-liquor/index.js:48-52`).

### Failure modes

- Constructor `TypeError`s for missing `appId/apiKey/indexName`,
  `slug/origin`, or `mapHit` (`algolia.js:46-54`).
- Transport failures inherit `getJson` semantics: retry with backoff on
  429/502/503/504 and retryable network errors, hard status errors naming
  the operation, WAF-challenge-with-200 detected at JSON parse
  (see `docs/apis/shared-transport.md`).

---

## Constructor.io — `retailers/_lib/constructor-io.js`

Search/browse API authenticated only by a public site key published in
storefront bundles (e.g. Kmart NZ). No full-index browse: coverage comes
from sweeping query terms.

**Used by:** 1 retailer — `kmart` (`retailers/kmart/index.js:23` sweeps
`a`–`z`).

### Endpoint & auth

- `GET https://ac.cnstrc.com/search/{term}?key={key}&num_results_per_page={n}&page={n}`
  (`constructor-io.js:13`, `constructor-io.js:91-94`). Term and key are
  URL-encoded; the key rides in the query string but is kept out of error
  labels (`operation` = `constructor {slug} "{term}" p{page}`).
- Headers: `accept: application/json`, optional `user-agent`
  (`constructor-io.js:72`); `cleanHeaders` drops an unset user-agent
  instead of sending the literal string `"undefined"` (via
  `http.js:19-22`).

### Consumed response fields (per result)

- `response.results: array` — required; junk → `[]`
  (`parseConstructorResults`, `constructor-io.js:17-19`).
- Default item mapping (`mapConstructorItem`, `constructor-io.js:26-53`):
  - `value: string` — product name
  - `data.id: string` ("P_43684687") or `id` — `P_` prefix stripped →
    `retailerProductId`
  - `data.uri: string` — product path, joined onto `store.origin`
  - `data.Brand: string` — brand
  - `data.image_url: string` — image
  - `variations[0].data.price: number` — current price (dollars → cents)
  - `variations[0].data.prices[].{type:"list", amount:number}` — list
    price; when above the current price it becomes `regularCents` and the
    current price becomes `promoCents`
  - `variations[0].data.apn: string` — digits only, trusted as GTIN at
    8–14 digits
- Items without id/name/positive price are dropped.

### Pagination

Per query term, pages 1..`maxPagesPerQuery` (default 5), stopping on a
short page (`results.length < pageSize`) or a page with zero fresh
products after dedup (`constructor-io.js:112-137`). A page-1 fetch failure
logs and skips the term; later-page failures propagate.

### Failure modes

- Constructor `TypeError`s for missing `key`, `slug/origin`, or empty
  `queries` (`constructor-io.js:56-62`).
- Transport: `search()` goes through the shared `getJson` seam
  (`constructor-io.js:91-107`) — configured timeout honored (default
  25 s), status errors name slug/term/page, WAF pages served with status
  200 fail as typed JSON errors, bodies capped at 20 MB.

---

## eStar `window.category` — `retailers/_lib/estar-category.js`

eStar-platform storefronts embed the whole category payload as
`window.category = {…}` in a script tag. Verified live on liquorland,
baby-factory, whitcoulls, glassons, postie, number-one-shoes
(`estar-category.js:1-10`).

**Used by:** 6 retailers — `liquorland`, `baby-factory`, `whitcoulls`,
`glassons`, `postie`, `number-one-shoes`.

### Endpoint & auth

- `GET {origin}/{categoryPath}` with server-side pagination appended as
  `?p={page}` (param configurable via `pageParam`) when `page > 1`
  (`estar-category.js:156-160`). No auth; requests send `BROWSER_UA`
  (`http.js:11-12`) and `accept: text/html,...` (`estar-category.js:137`).
- HTML is fetched as text via `getText`, never JSON.

### Page parsing

- `parseWindowJson(html, marker)` (`estar-category.js:49-70`) scans for
  the first balanced `{…}` after the `window.category` assignment —
  string/escape aware (`balancedObject`, `estar-category.js:16-41`) — and
  falls back to parsing the inner object of an object-spread assignment
  (`window.category = { …{…} }`). Returns `undefined` when the marker is
  absent or the payload is not pure JSON (also for non-string input).
  **Risk:** a JS (non-JSON) payload with trailing commas, comments, or
  computed keys silently yields `undefined` → the run sees an empty
  category rather than an error; the runner's zero-valid-observations
  check (`runner.js:105-108`) is the backstop.
- `parseEstarItems` (`estar-category.js:72-74`): `items: array` or `[]`.

### Consumed item fields (`mapEstarItem`, `estar-category.js:91-118`)

- `productid` (or `id`), `description` (or `name`) — identity
- `variants[].{unitprice, saleprice, originalunitprice, baseunitprice}`
  — prices via `toCents`; variants may nest under `stylecolour.variants`;
  the first variant with a priced `unitprice`/`saleprice` wins
  (`estar-category.js:79-88`); boolean `saleprice` is not a price
- `hidewasprice` (variant or item) — suppresses the was-price
- `url` or `stylecolour.urlkey` — product URL
- `label` — brand
- `variants[].barcode` — digits only, trusted as GTIN at 8–14 digits
  (some retailers keep 6-digit stock codes there, `estar-category.js:101-103`)
- `images[0].src` — image

### Pagination

Server-side only when `pageParam` is set (all six retailers use `p`);
otherwise page 1 only. The walk stops early when a page yields zero fresh
products after dedup by `productid` (`estar-category.js:171-208`,
default `maxPages: 20`). Category label is derived from the path and
prepended to `product.categories`. A page-1 failure logs and skips the
category; later-page failures propagate.

### Failure modes

Constructor `TypeError`s for missing `slug/origin`/`categories`
(`estar-category.js:121-127`); transport via `getText`.

---

## Next.js `__NEXT_DATA__` — `retailers/_lib/next-data.js`

Next.js storefronts dehydrate react-query state into
`__NEXT_DATA__.props.pageProps.dehydratedState.queries`. Category results
live in the query whose `queryKey[0]` matches a marker (default
`"category-search"`) as `{ state: { data: { results: {…}, totalCount } } }`
(`next-data.js:1-9`).

**Used by:** 1 retailer — `bunnings` (Coveo-shaped `raw` records).

### Endpoint & auth

- `GET {origin}/{categoryPath}` with `?{pageParam}={page}` for `page > 1`
  (default param `page`, `next-data.js:73`, `next-data.js:96-98`). No
  auth; optional `user-agent`, fetched as text via `getText`.

### Page parsing

- `parseNextData(html)` (`next-data.js:15-27`): slices the JSON between
  the `__NEXT_DATA__` marker's enclosing `>` and `</script>`; returns
  `undefined` when absent or unparsable (also for non-string input).
  **Risk:** the extraction is marker-and-index based, not DOM-based — a
  storefront shipping `>`/`</script>` inside the JSON string itself, or a
  restructured `props` tree, yields `undefined` (empty page) rather than
  an error. Bad JSON at the marker is also swallowed to `undefined`; the
  runner's zero-valid-observations check is the backstop.
- `findDehydratedQuery(json, marker)` (`next-data.js:30-34`): finds the
  entry whose `queryKey[0] === marker`; `undefined` if the
  `dehydratedState.queries` array is missing.
- `results` is an object map (`{"0": {raw: {...}}, …}`), not an array;
  values are unwrapped through `entry.raw` (`next-data.js:109-112`).

### Consumed raw fields (`mapRawItem`, `next-data.js:41-58`)

Bunnings/Coveo shape: `code` (→ `retailerProductId`), `name`,
`brandname`, `price:number` (dollars → cents), `imageurl`,
`productroutingurl` (joined onto origin). Items without code/name/positive
price are dropped.

### Pagination

`maxPages` (default 3) per category, also stopping when
`collected >= maxPages * pageSize` or a page returns zero items
(`next-data.js:115-156`). Category label = last path segment. Page-1
failure logs and skips the category; later-page failures propagate.

### Failure modes

Constructor `TypeError`s for missing `slug/origin`/`categories`
(`next-data.js:61-67`); transport via `getText`.

---

## JSON-LD product pages — `retailers/_lib/jsonld-pdp.js`

The universal fallback for custom storefronts without listing APIs:
product URLs from sitemaps, one request per server-rendered PDP carrying
schema.org JSON-LD (`<script type="application/ld+json">`).

**Used by:** 3 retailers — `commonsense-organics`, `moore-wilsons`,
`officemax` (each also reusing `parseJsonLdProducts`/`jsonLdProductSpec`
inside a custom `mapHtml`).

### Endpoints & auth

- Sitemap fetches: `GET {sitemapUrl}`; `<sitemapindex>` documents are
  expanded into child shards (first `maxShards`, default 10) whose
  `<loc>` URLs are collected (`jsonld-pdp.js:130-145`). URLs are
  deduped and filtered by `urlFilter` (default `/\//`).
- PDP fetches: `GET {productUrl}` per item.
- No auth; optional `user-agent`; both fetched as text via `getText`.

### Page parsing

- `parseJsonLdProducts(html)` (`jsonld-pdp.js:16-39`): regex-extracts all
  ld+json blocks, tolerates a single top-level object, an array of nodes,
  or `@graph` (object or array), and returns nodes whose `@type` (string
  or array) includes `"Product"`. Per-block JSON errors are skipped, not
  thrown; non-string input returns `[]`.
- Sites with microdata instead of JSON-LD supply `mapHtml(html, url)`
  returning the same spec shape (`jsonld-pdp.js:7-9`).

### Consumed Product fields (`jsonLdProductSpec`, `jsonld-pdp.js:42-80`)

- `name: string` — required, trimmed
- `offers` — single Offer, array (cheapest wins), or AggregateOffer
  (`lowPrice`); price may sit in `price` or `priceSpecification` (also
  possibly an array, first entry wins). Dollar strings go through
  `toCents`. `highPrice` across offers supplies the was-price; when above
  the current price it becomes `regularCents` with the current price as
  `promoCents`.
- `brand` / `manufacturer` — string or `{name}`
- `gtin13` / `gtin` / `gtin12` / `sku` — digits only, trusted as GTIN at
  8–14 digits
- `image` — string or array (first wins)

### Pagination

No page numbers: the run is cost-bounded to `maxPages × pageSize`
products (defaults 10 × 10). `collectProducts`
(`jsonld-pdp.js:152-183`) fetches sitemaps once, then walks URLs until
the budget is hit; per-PDP failures log and skip that URL. Counting is
conservative — only successfully built observations consume budget.

### Failure modes

Constructor `TypeError`s for missing `slug/origin`, a non-function
`mapHtml`, or empty `sitemaps` (`jsonld-pdp.js:83-92`); transport via
`getText`. Sitemap/PDP fetch failures surface through the shared
`getText` error semantics.
