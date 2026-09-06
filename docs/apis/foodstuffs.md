# Foodstuffs upstream HTTP APIs (New World / PAK'nSAVE)

Reference for what the Foodstuffs collectors actually send and consume.
Everything here is derived from code and existing tests/fixtures — no live
calls were made to write it. Two separate backends are in use:

| Backend | Adapter | Used by |
|---|---|---|
| Web/Algolia API (`api-prod.{paknsave,newworld}.co.nz`) | `src/adapters/foodstuffs.js` (`FoodstuffsClient`, `PaknsaveClient`, `NewWorldClient`) | `npm run paknsave`, `npm run newworld` |
| Mobile-app API (`api-prod.prod.fsniwaikato.kiwi/prod`) | `src/adapters/foodstuffs-mobile.js` (`MobileFoodstuffsClient`) | `node scripts/foodstuffs-mobile-breadth.js` |

Both adapters share the domain mapper `toPriceObservation`
(`src/adapters/foodstuffs.js:83`), re-exported by the mobile adapter
(`src/adapters/foodstuffs-mobile.js:33`). The public type contract is
`src/adapters/foodstuffs.d.ts`.

## 1. Overview

Foodstuffs operates both PAK'nSAVE and New World on one e-commerce platform;
the two banners differ only in origins/identifiers, captured in the `BANNERS`
table (`src/adapters/foodstuffs.js:7`): `paknsave` → apiBanner `PNS`, store
banner `PNS`; `newworld` → apiBanner `NW`, store banner `MNW`.

Entry commands:

- `npm run paknsave` → `scripts/paknsave.js`. The one script serves both
  banners: `scripts/newworld.js` just sets `process.env.FOODSTUFFS_BANNER =
  "newworld"` and imports it (`scripts/newworld.js:3-4`). Subcommands:
  `stores`, `deals`, `feed`, `search`, `archive`, `track`, `sales`
  (usage: `scripts/paknsave.js:59-72`).
  - `archive --all-stores` lists every store via the API and archives one
    specials snapshot per store with `archiveEachStore`
    (`scripts/paknsave.js:105-149`); `--delay-ms` between stores defaults to
    1000 (`scripts/paknsave.js:112`). `--pages all` (default) means unlimited
    pages; a number caps `maxPages`.
  - A store argument may be a UUID or an unambiguous name; ambiguity is an
    error listing the matches (`resolveStore`, `scripts/paknsave.js:42-56`).
- `node scripts/foodstuffs-mobile-breadth.js` — full-catalogue breadth
  collector on the mobile backend. Flags: `--retailer paknsave|newworld`,
  `--store` (repeatable), `--file`, `--delay-ms` (default 5000), `--budget`
  (hard cap on HTTP calls), `--min-expected-products`, `--force-discovery`,
  `--force-live` (`parseArgs`, `scripts/foodstuffs-mobile-breadth.js:655-727`).

## 2. Endpoints

### Web/Algolia API (base `{webOrigin}` for auth, `{apiOrigin}` for data)

| Purpose | Method | URL | Notable params |
|---|---|---|---|
| Anonymous auth (token mint) | POST | `{webOrigin}/api/user/get-current-user` | Body `{fingerprintUser, fingerprintGuest}` (`src/adapters/foodstuffs.js:177-187`) |
| Store list | GET | `{apiOrigin}/v1/edge/store` | none (`src/adapters/foodstuffs.js:241`) |
| Product search / deals / full listing | POST | `{apiOrigin}/v1/edge/search/paginated/products` | Body carries an Algolia query (below) (`src/adapters/foodstuffs.js:294`) |
| Mobile-style specials listing | POST | `{apiOrigin}/mobile/ecomm-products/{PNS\|NW}/{storeId}/specials?page={n}` | Body `{}` (`listMobileDeals`, `src/adapters/foodstuffs.js:336-347`) |

Search body highlights (`src/adapters/foodstuffs.js:297-329`): `algoliaQuery`
with `filters` conjunction `stores:{storeId}[ AND onPromotion:{storeId}][ AND
{extraFilters…}]` (`src/adapters/foodstuffs.js:288-293`), `hitsPerPage`
(default 50, server max 50), `page` (zero-based), `maxValuesPerFacet: 100`,
`facets: [brand, category0NI, category1NI, productFacets, tobacco]`,
`analyticsTags: ["nz-grocery-prices"]`, optional `query`; top-level
`sortOrder: "{NI|SI}_POPULARITY_ASC"`, `tobaccoQuery: false`, and a
`precisionMedia` block with `disableAds: true`.

### Mobile-app API (base `https://api-prod.prod.fsniwaikato.kiwi/prod`)

| Purpose | Method | URL | Notable params |
|---|---|---|---|
| Guest login | POST | `/mobile/user/login/guest` | Body `{banner: "PNS"\|"MNW"}` (`src/adapters/foodstuffs-mobile.js:122-131`) |
| Physical store list | GET | `/mobile/store/physical?banner={PNS\|MNW}` | POST answers 405; GET is live-verified (`src/adapters/foodstuffs-mobile.js:231-238`) |
| Category tree | GET | `/mobile/v1/products/category?storeId={id}&banner={paknsave\|newworld}&region={NI\|SI}` | `storeId` URL-encoded (`src/adapters/foodstuffs-mobile.js:244-258`) |
| Category products (one page) | POST | `/mobile/ecomm-products/{PNS\|MNW}/{storeId}/category?cat0={name}[&cat1=][&cat2=]&sortOrder=Popularity&page={n}` | Body `[]`; names URL-encoded (`src/adapters/foodstuffs-mobile.js:264-289`) |

## 3. Auth & headers

Web adapter:

- Token = anonymous JWT from the auth endpoint. The request body carries a
  random per-client `fingerprintUser` (UUID with dashes stripped,
  `src/adapters/foodstuffs.js:157,184`); no credentials or secrets involved.
- Cached in `#accessToken` until `expires_time` minus a 60 s margin
  (`src/adapters/foodstuffs.js:173-176`); `expires_time` must parse to a
  finite date or a clear error is thrown (`src/adapters/foodstuffs.js:202-211`).
- Data requests send `authorization: Bearer {token}`, `accept:
  application/json`, `origin`, `referer`, `user-agent`
  (`src/adapters/foodstuffs.js:222-229`). Default UA is the honest
  `Mozilla/5.0 (compatible; nz-grocery-prices/0.1; …)`
  (`src/adapters/foodstuffs.js:4-5`).

Mobile adapter:

- Token = guest JWT from `/mobile/user/login/guest` with body
  `{banner}`. Cached until `expires_in` seconds minus a 60 s margin
  (`TOKEN_EXPIRY_MARGIN_MS`, `src/adapters/foodstuffs-mobile.js:21,111`);
  `expires_in` must be a positive finite number
  (`src/adapters/foodstuffs-mobile.js:151-160`). Concurrent first calls share
  one in-flight auth promise (`src/adapters/foodstuffs-mobile.js:117-166`).
- Authenticated requests send `accept: application/json`,
  `authorization: Bearer {token}`, `user-agent` (default
  `PAKnSAVEApp/4.32.0 (App Version)`, `src/adapters/foodstuffs-mobile.js:20,190-197`).
- Neither adapter logs tokens or puts them in error messages; errors quote
  status lines and JSON field names only.

## 4. Request params

- `storeId`: Foodstuffs store UUID. Web search scopes via the Algolia filter
  `stores:{storeId}`; mobile paths embed it in the URL (URL-encoded).
- `page`: zero-based.
- `hitsPerPage` (web search only): default/max 50 server-side — 100 returns
  HTTP 400 (measured, `docs/research/foodstuffs-full-catalogue.md`).
- `region`: `"NI"` (default) or `"SI"`; web builds `sortOrder` prefix, mobile
  passes `region=` on the tree call.
- `onPromotion` (web): adds `onPromotion:{storeId}` to the filter conjunction
  (`src/adapters/foodstuffs.js:289`).
- `extraFilters` (web): raw Algolia filter strings (e.g.
  `category0NI:"Chilled & Dairy"`) appended verbatim with AND; non-string or
  blank entries throw `TypeError` (`src/adapters/foodstuffs.js:56-71`).
- `query` (web): free-text Algolia `query`.
- Mobile `categoryPage`: `cat0` required, `cat1`/`cat2` optional category
  names — the API cannot express deeper levels.

## 5. Response shape (consumed fields only)

Web search envelope (`/v1/edge/search/paginated/products`):

| Field | Type | Use |
|---|---|---|
| `products` | array of product objects | mapped by `toPriceObservation` |
| `totalPages` | number | pagination loop (`collectProducts`) |
| `totalHits`, `page`, `hitsPerPage` | number | passed through / diagnostics |
| `algoliaSearchResult.facets` | object | facet-driven crawls pass through unmodified |

Mobile specials envelope (`/mobile/ecomm-products/.../specials`):

| Field | Type | Use |
|---|---|---|
| `products` | array of product objects | mapped by `toPriceObservation` |
| `numberOfPages` | number | pagination loop (`collectDeals`) |

Mobile store list: bare array, `{stores:[...]}`, or `{items:[...]}` — all
normalized to an array (`normalizeStoreList`,
`src/adapters/foodstuffs-mobile.js:39-44`). Web store list: `{stores:[...]}`,
filtered server-side response to the client's banner
(`src/adapters/foodstuffs.js:241-256`).

Product objects consumed by `toPriceObservation`
(`src/adapters/foodstuffs.js:83-140`):

| Field | Type | Notes |
|---|---|---|
| `productId` | string | e.g. `5004821-EA-000`; identity for dedupe |
| `name`, `displayName`, `units`, `brand` | string | display name is `[name, displayName ?? units].join(" ")` |
| `price` / `singlePrice.price` / `multiPrice.price` | integer (cents) | first integer wins (`centsFromProduct`); otherwise the product is skipped |
| `singlePrice.comparativePrice` | object | unit-price comparison, cloned into `price.comparative` |
| `unitPrice` | string | fallback comparative `{display}` |
| `promotions[]` | array | `promoId`, `rewardType`, `threshold?`, `limit?`, `cardDependencyFlag`, `decalImageUrl?`; `bestPromotion: true` preferred, else first |
| `decalCode`, `decalImageUrl` | string | fallback promotion `decal:{code}` when no promotions array |
| `categoryTrees[0]` / `categories` | object values / array | category names |
| `productImageUrls` | object | cloned into `product.images` |

Store objects: `id`, `name`, `address?`, `region?`, `banner?` (web filters by
`banner === PNS|MNW`), `onlineActive?` (mobile breadth skips
`onlineActive: false` stores — their tree 500s;
`scripts/foodstuffs-mobile-breadth.js:798`).

Mobile category tree: array of nodes `{name, code, children[]}` of arbitrary
depth.

Auth payloads: web `{access_token: string, expires_time: string}`; mobile
`{access_token: string, expires_in: number}`.

## 6. Pagination / enumeration strategy

- Web `collectProducts`/`collectDeals`: do/while loop, `page` 0..n, stops at
  `totalPages`/`numberOfPages` or `maxPages`
  (`src/adapters/foodstuffs.js:357-404`). The search API clamps `totalHits`
  at 1,000 / `totalPages` at 20, so blind web pagination reaches only ~1 k of
  ~9-14 k products per store (measured,
  `docs/research/foodstuffs-full-catalogue.md`) — that is why breadth moved
  to the mobile backend.
- Mobile breadth (`scripts/foodstuffs-mobile-breadth.js`): fetch the category
  tree once per store, walk every node at depth 0..2 (`cat0/cat1/cat2`);
  a page with `totalHits >= 1000` (`HIT_CLAMP`,
  `scripts/foodstuffs-mobile-breadth.js:70,185-187`) drills into tree
  children; saturated nodes with no drillable children are recorded as
  `incompleteCoverage` instead of silently truncated
  (`scripts/foodstuffs-mobile-breadth.js:441-484`). Non-saturated nodes
  paginate fully via `continuationPages`
  (`scripts/foodstuffs-mobile-breadth.js:193-203`). Products dedupe by
  `productId` across overlapping categories. Continuation pages checkpoint in
  `<file>.breadth-manifest.json` for resume.
- `--all-stores` (web CLI): enumerates stores from `/v1/edge/store` and
  archives one specials snapshot per store, `--delay-ms` (default 1000)
  between stores (`scripts/paknsave.js:105-149`). Mobile breadth resolves
  stores from `/mobile/store/physical`, defaulting to the alphabetically
  first online-active store when no `--store` is given
  (`scripts/foodstuffs-mobile-breadth.js:802-809`).

## 7. Timeouts / retries / rate limiting

- Web adapter: every HTTP call (auth included) goes through
  `fetchWithRetry` from `src/adapters/fetch-with-retry.js` with
  `timeout` (default 15 000 ms, per attempt) and `signal` passed through
  (`src/adapters/foodstuffs.js:177-198,216-236`). Retry policy lives in that
  shared module: GET only, retries on 429/502/503/504 and retryable network
  errors with exponential backoff + jitter and `Retry-After` support; POSTs
  (search/specials) are single-attempt.
- Mobile adapter: bare injected `fetch` with `AbortSignal.timeout`
  (default 20 000 ms per attempt,
  `src/adapters/foodstuffs-mobile.js:125,191`). Retries live in the client:
  up to 2 extra attempts (`RETRYABLE_ATTEMPTS`) on 5xx or any thrown network
  error, linear backoff `retryBackoffMs * attempt` (default 3 000 ms,
  `src/adapters/foodstuffs-mobile.js:23-25,184-229`).
- Politeness: mobile client enforces a minimum gap between completed requests
  (`delayMs`, default 0 in the class, 5 000 ms in the breadth script,
  `src/adapters/foodstuffs-mobile.js:85-91`). Web `--all-stores` spaces
  stores by `--delay-ms` (default 1000). The breadth script adds walker-level
  retry rounds (3 rounds, 10 s gap) for bootstrap calls (store list, tree)
  (`scripts/foodstuffs-mobile-breadth.js:66-67`).

## 8. Failure modes

- Non-2xx: web throws `Foodstuffs {operation} failed: {status} {statusText}`
  (`assertOk`, `src/adapters/foodstuffs.js:24-29`); mobile throws
  `Mobile request {path} failed: …` / `Mobile guest auth failed: …` after
  retryable attempts are exhausted.
- 200-with-non-JSON (WAF challenge): both adapters parse via
  `parseJsonResponse` from `src/adapters/fetch-with-retry.js`, which raises a
  contextual error (operation, status, content-type, body prefix, 20 MiB body
  cap) instead of a bare `Unexpected token`.
- Malformed auth payload: missing token, non-object payload, or (web)
  unparseable `expires_time` each throw a clear error naming the operation
  (`src/adapters/foodstuffs.js:196-211`,
  `src/adapters/foodstuffs-mobile.js:142-160`); NaN `expires_time` would
  otherwise silently disable the token cache.
- Malformed listing envelope: the collect loops validate `products` is an
  array and `totalPages`/`numberOfPages` is numeric, throwing a clear error
  instead of `undefined is not iterable` or a silent one-page truncation
  (`assertPagedEnvelope`, `src/adapters/foodstuffs.js:73-81`).
- Unpriced products: `toPriceObservation` returns `undefined` and the collect
  loops filter them out — a missing price is not an error.
- Unknown store: `getStore` throws `Unknown {retailer} store: {id}`
  (`src/adapters/foodstuffs.js:262`); the CLI distinguishes no-match vs
  ambiguous names (`scripts/paknsave.js:50-55`).
- Breadth-specific: circuit breaker opens after 5 consecutive failed requests
  and aborts the run (`BREAKER_THRESHOLD`,
  `scripts/foodstuffs-mobile-breadth.js:58`); `--budget` exhaustion rejects
  remaining work with `EBREADTHBUDGET`; empty continuation pages beyond
  catalogue end stop that category's scheduling; the run is `healthy: false`
  (exit 1) on incomplete coverage, budget stop, errors, or below-floor unique
  product counts.

## 9. Pointers

- Adapters: `src/adapters/foodstuffs.js`, `src/adapters/foodstuffs-mobile.js`,
  contract `src/adapters/foodstuffs.d.ts`.
- Shared transport: `src/adapters/fetch-with-retry.js` (`fetchWithRetry`,
  `parseJsonResponse`, `TimeoutError`).
- Tests: `test/adapters/foodstuffs.test.js` (mapping, extraFilters, envelope
  passthrough, malformed auth/payload hardening),
  `test/adapters/foodstuffs-mobile.test.js` (auth caching/memoization,
  URL shapes, retries, hardening),
  `test/foodstuffs-mobile-breadth.test.js` (planner, crawler bridge,
  `crawlStore`, CLI parsing).
- Scripts: `scripts/paknsave.js` (both banners), `scripts/newworld.js`,
  `scripts/foodstuffs-mobile-breadth.js`, helpers
  `scripts/lib/store-archive-loop.js`, `scripts/lib/breadth-helpers.js`,
  `scripts/lib/crawler.js`.
- Live-measured API facts (page caps, facets, store counts):
  `docs/research/foodstuffs-full-catalogue.md`.
