# Woolworths all-stores collection: speed-up investigation

Date: 2026-07-17. Investigated live against woolworths.co.nz with ~45 light verification
requests while the daily run was in progress. No repo code was modified.

## TL;DR

The session-switch dance (warm-up GET + `PUT /fulfilment/my/methods/pickup` +
`PUT /fulfilment/my/pickup-addresses`) is **unnecessary**. A single crafted cookie —

```
cookie: cw-lrkswrdjp=f-<fulfilmentStoreId>
```

— on an otherwise **sessionless** request to `/api/v1/products?target=specials...`
returns that store's prices directly (verified). Sessionless requests also parallelize
cleanly across stores (verified, 4 concurrent), and the page-size cap is **120**
(verified; 200+ → HTTP 400). Combining these takes the ~180-store sweep from
**~2.5–3 hours to ~20–30 minutes** at a polite 4-way concurrency, with *fewer* total
requests than today.

## Measured baseline (today's run)

- Run started 12:19; per-store snapshot timestamps are ~55–60 s apart → full ~180-store
  sweep ≈ 2¾ h.
- Each store returns **~3,850–4,400 specials** → ~43 pages at `size=100`, plus 1–2 PUTs,
  all serialized on one sticky session ≈ 8,000 sequential requests total.
- Observed API latency: ~0.6–1.3 s per specials page (no artificial per-page delay in
  `collectDeals`; the 1000 ms `WOOLWORTHS_DELAY_MS` only sleeps *between stores*, so it
  contributes just ~3 min of the runtime). **The runtime is almost entirely serialized
  request latency, not the configured delay.**

## Verified findings

### 1. The fulfilment store is selected by a plain cookie — no PUTs, no session

`PUT /api/v1/fulfilment/my/pickup-addresses` responds with a Set-Cookie:

```
cw-lrkswrdjp=dm-Pickup,f-9584,a-1002,s-38
```

`f-<id>` is the fulfilment store id. Sending **only** the minimal form on a fresh,
cookie-less request works:

```
GET https://www.woolworths.co.nz/api/v1/products?target=specials&useRankedSpecials=true&page=1&size=120
cookie: cw-lrkswrdjp=f-9584
(plus the adapter's existing headers: x-requested-with: OnlineShopping.WebApp, etc.)
```

→ `context.fulfilment = { fulfilmentStoreId: 9584, method: "Pickup", ... }` and
store-zone-correct prices (e.g. sku 6051661 originalPrice **9.29** for 9584 vs **8.60**
for North Island stores — matches the values obtained via the full PUT dance).

Caveats (all verified):

- **Only works sessionless.** If the jar already carries an `ASP.NET_SessionId` whose
  server-side state has fulfilment set (e.g. after any warm-up request), the session
  state wins and the cookie is ignored. So: *don't warm the session; seed a fresh jar
  with the crafted cookie.* The first store-scoped response's own Set-Cookie session can
  then be reused for that store's remaining pages (its server state now holds the right
  store).
- **Invalid ids fail silently**: `cw-lrkswrdjp=f-99999` → falls back to the anonymous
  default (9171 / Courier / Glenfield) with HTTP 200. The collector must assert
  `context.fulfilment.fulfilmentStoreId === expected && method === "Pickup"` on every
  page and treat a mismatch as a store failure. (`collectDeals` already checks
  cross-page consistency; it additionally needs the *expected id* check.)

### 2. Sessionless requests parallelize; sticky sessions do not

- 4 concurrent sessionless requests, each pinned to a different store via the cookie:
  all completed in **1.17 s total** (~1 s each — same as a lone request).
- 4 concurrent pages *inside one sticky session*: **10.3 s** (~2.5 s each) — classic
  ASP.NET per-session serialization. Intra-session parallelism is a dead end;
  cross-store parallelism is the lever.
- Two full `WoolworthsClient` instances with separate jars, `setPickupStore` in
  parallel to different stores, concurrent page fetches: no cross-talk, correct
  per-store prices (verified sku 909276: 4.49 vs 4.75; 6051661: 9.29 vs 8.60).

### 3. Page size cap is 120

| `size=` | result |
|---|---|
| 100 | 200 OK, ~108–128 items/page (ranked specials pad the page) |
| 120 | 200 OK, ~119–128 items/page |
| 200 | **400 Bad Request** |
| 500 | **400 Bad Request** |

`size=120` cuts ~43 pages/store to **~33–37 pages/store** (~16 % fewer requests).
Deep pages work sessionless (verified page 32 of `f-9505`).

### 4. Pagination is deterministic — safe without a sticky session

Page 1 and page 2 fetched twice each as fully independent sessionless requests:
identical SKU lists in identical order, zero overlap between pages, identical
`totalItems`. `useRankedSpecials=false` returned the same set (no advantage either way).

### 5. No conditional-request support

`cache-control: no-cache`; no `ETag`, no `Last-Modified` on `/api/v1/products`.
If-Modified-Since / If-None-Match "only-changed" collection is not possible.
No rate-limit headers were observed on any response (fetchWithRetry's 429/503 +
Retry-After handling remains the safety net).

### 6. `/api/v1/addresses/pickup-addresses` works sessionless too

The warm-up in `listStores()` is unnecessary — the endpoint returns the full list with
no cookies at all (verified, HTTP 200). Payload contains only pickup-address
`id`/`name`/`address`; it does **not** expose the fulfilment store id, so a
pickupAddressId → fulfilmentStoreId mapping must come from elsewhere (see below).

### 7. Pickup addresses are N:1 with fulfilment stores (small dedup win)

Alexandra (pickupAddressId 3496448) and Wanaka (3016497) both resolve to fulfilment
store **9584**. In today's partial run, 109 pickup addresses had produced only 105
distinct fulfilment stores (4 duplicates by that point). Collecting by distinct
fulfilment id skips a handful of fully redundant ~35-page crawls (~3–5 % saved).

### 8. Store id discovery: mobile-app site list is open

`GET https://api.cdx.nz/site-location/api/v1/sites` (no auth, no key; plain JSON,
~290 KB) returns **183 sites** with `site.id` = fulfilment store id, name, geo,
trading hours, and `extra2` = pickupAddressId. Coverage is imperfect — a few ids that
verifiably work as `f-` targets (e.g. 9555 Aotea, 9505 Huntly) are absent — so use it
as a cross-check, not the source of truth. The robust source of truth is a **one-time
enumeration**: run the existing `setPickupStore` PUT once per pickup address (~180 PUT
pairs, a few minutes, once), cache `{pickupAddressId, fulfilmentStoreId, name, address}`
to a JSON file, and re-enumerate only pickup addresses that later appear/disappear from
`/api/v1/addresses/pickup-addresses`.

### 9. Prices cluster into ~2 island-level zones with rare per-store outliers

From today's per-store data (72 stores with complete offer sets): exact price-vector
comparison on ~3,400–3,900 shared SKUs groups stores into **2 large clusters**
(North Island ≈ 47 stores, South Island ≈ 21) plus **3 genuine single-store deviants**
(Feilding 9471, Flaxmere 9702, Kilbirnie 9410). The cdx site list carries a
`extra5: "Zone 1..4"` field, but it doesn't line up cleanly with the observed clusters
and misses stores — treat the empirical clustering as authoritative. Assortment
(which SKUs are on special) still differs per store, so zone-sampling trades away
per-store assortment detail, not just prices.

## Recommendations (ranked by speed gain × ease × politeness)

1. **Sessionless crafted-cookie store selection + N parallel workers** (the big one).
   Replace warm-up + 2 PUTs + sticky jar with: fresh `CookieJar` seeded
   `cw-lrkswrdjp=f-<storeId>` per store; a small worker pool (4 workers, ~250 ms pause
   between pages per worker) walking the distinct-fulfilment-store list; pages
   sequential within a store (they must be — reusing the store's session serializes
   anyway, and order doesn't matter but politeness does). Assert
   `fulfilmentStoreId === expected && method === "Pickup"` every page.
   Effort: small — the adapter's existing `CookieJar`/`collectDeals` machinery already
   fits (`new WoolworthsClient({ cookie: "cw-lrkswrdjp=f-9584" })` plus the assert).
   Risk: the cookie name/format is undocumented and could change — keep the PUT-based
   `setPickupStore` path as fallback; the per-page assert makes any breakage loud, and
   the fallback restores today's behaviour.

2. **`size=120` instead of 100.** One-line change, verified cap, ~16 % fewer requests.
   Works with both the new and old store-selection paths.

3. **Collect by distinct fulfilment store id** (needs the one-time PUT enumeration from
   finding 8, cached in-repo). Saves the duplicate crawls (~3–5 %), gives stable store
   identity, and removes the need to touch `pickup-addresses` on every run.

4. **Drop the warm-up request in `listStores()`** — endpoint is sessionless (finding 6).
   Micro-win, trivial.

5. *(Optional, larger data-model decision)* **Zone-aware schedule**: daily collect one
   representative store per observed price cluster plus the known deviants
   (~6–10 stores ≈ 350 requests ≈ 3–4 min), full 180-store sweep weekly to detect
   cluster drift and per-store assortment changes. Only worth it if week-old data for
   non-representative stores is acceptable; recommendation 1 already makes the full
   daily sweep cheap, so treat this as a future volume reducer, not a necessity.

Not viable / not needed: conditional GETs (no ETag support — finding 5); bigger pages
(400 above 120); GraphQL/mobile pricing APIs (the cookie mechanism already reduces
overhead to the irreducible listing payload; api.cdx.nz product endpoints look
auth-gated and weren't probed); intra-session parallel pages (server-serialized).

## Estimated new runtime (~180-store sweep)

Requests: ~175 distinct stores × ~34 pages (size 120) ≈ **6,000 GETs**, no PUTs
(vs ~8,000 today).

| configuration | est. wall time |
|---|---|
| today (1 session, serialized, size 100) | ~2.5–3 h (measured pace) |
| sequential + recs 2–4 only | ~1.7 h |
| **4 workers, 250 ms/page pacing (recommended)** | **~25–30 min** |
| 6 workers | ~18–20 min |

4 workers ≈ 3.5–4 req/s aggregate for ~25 min, once a day at 4 am NZT — comparable to
one person browsing quickly, and below anything likely to trip Akamai Bot Manager
(present on the site: `ak_bmsc`/`_abck`/`bm_sz`; the honest UA + polite pacing have
never been challenged). Keep `fetchWithRetry`'s 429/503 + Retry-After backoff, and back
off the pool (halve workers) if any 429 appears.

## Verified endpoint reference

| purpose | request | notes |
|---|---|---|
| store-scoped specials, no session | `GET /api/v1/products?target=specials&useRankedSpecials=true&page=N&size=120` + `cookie: cw-lrkswrdjp=f-<storeId>` + headers `x-requested-with: OnlineShopping.WebApp`, `accept: application/json`, referer `/shop/specials` | 200; `context.fulfilment.fulfilmentStoreId` echoes store; invalid id silently falls back to 9171/Courier — must assert |
| page-size cap | same, `size=120` max | `size≥200` → 400 |
| pickup address list | `GET /api/v1/addresses/pickup-addresses` | works with zero cookies; addresses only, no store ids |
| pickupAddressId → storeId | `PUT /api/v1/fulfilment/my/methods/pickup` `{}` then `PUT /api/v1/fulfilment/my/pickup-addresses` `{"addressId":N}` on a warmed session | today's dance; keep for one-time mapping + fallback |
| all sites (mobile app) | `GET https://api.cdx.nz/site-location/api/v1/sites` | open, 183 sites, `site.id` = fulfilment id, `extra2` = pickupAddressId, `extra5` = "Zone n"; incomplete coverage |

Probe scripts (reproducible): `/private/tmp/claude-501/-Users-server-Code-prices/9548aa9c-a42b-411f-94d2-b1e68794900b/scratchpad/probe{1..5}-*.mjs`.
