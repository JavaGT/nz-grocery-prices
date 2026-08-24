# Woolworths NZ — full-catalogue breadth & multi-store research

**Date:** 2026-08-24 · **Method:** ~40 tiny live probes (page=1, size≤100, ≥2s sleeps) against
`https://www.woolworths.co.nz` plus static analysis of the public SPA bundle
(`main.*.js`, `common.*.js`, `runtime.*.js`, `assets/settings.json`). All probes used the
same headers as `src/adapters/woolworths.js` (`x-requested-with: OnlineShopping.WebApp`,
JSON accept, `/shop/specials` referer, UA `nz-grocery-prices/0.1`) with **no cookies** unless
stated. Raw probe payloads were kept outside the repo and are not committed.

Legend: **[V]** = verified by live request this session · **[B]** = read from the site's own
production JS bundle · **[I]** = inferred, not directly tested.

---

## (a) General catalogue endpoint

### `target` is mandatory

- `GET /api/v1/products?page=1&size=5` → **400** `[V]`
  ```json
  {"message":"One or more errors occurred","errors":[{"field":"Target","message":"The Target field is required."}]}
  ```

### `target=browse` returns the general catalogue

- `GET /api/v1/products?target=browse&page=1&size=100` → 200, 100 items, in-stock catalogue
  with full price objects. **[V]**
- Other verified targets: `target=specials&useRankedSpecials=true` (existing collector) and
  `target=search&search=milk` (415 results for "milk"). **[V]**

### Parameter names matter — the SPA's own vocabulary (decoded from bundle + verified live)

The site's Angular app builds its product queries like this **[B]**:

```js
buildQuery() {
  return { discount, search, dynamicGroup, groupId,
           page: 1, size: currentPageSize, sort: currentSortOption,
           dasFilter: … , filters: … ,
           inStockProductsOnly: … }
}
```

| Param | Behavior | Status |
|---|---|---|
| `sort=` | Accepted values include `PriceAsc`, `PriceDesc`, `CUPAsc`, `CUPDesc`, `Recency`, `Relevance`, `Special`, `AvailableDate`, `name` **[B]**; `sort=PriceAsc` verified live (response `currentSortOption:"PriceAsc"`) **[V]** | ✅ |
| `dasFilter=` | Department/aisle/shelf scoping. Format `key;value;name;isBooleanValue(;group)`, URL-encoded, e.g. `Department;1;Fruit %26 Veg;false`. Verified: sets `breadcrumb.department`, filters items, `totalItems` becomes the department's in-stock count (327 vs facet total 717). | ✅ [V+B] |
| `department=…`, `sortBy=…`, `storeId=…` | **Silently ignored** (identical responses with/without). Verified live. | ❌ [V] |
| `inStockProductsOnly=false` | Present in the SPA query builder; not yet probed live. The browse default appears to be in-stock-only. | [B], untested |
| Page sizes | Site UI uses 24/48/120 (`ITEMS_PER_PAGE` **[B]**); API accepted 2/5/24/100 in probes. `size=1` on specials returned 9 items (server minimum-page quirk). | [V] |

Department ids/names come from `GET /api/v1/products/departments` **[V]** — an array of 13
departments (`{id, label, url}` plus per-aisle `dasFacets` with product counts), e.g.
Fruit & Veg (id 1), Pantry (7), Health & Body (10). Facet counts per department are also on
every browse response under `dasFacets[group="Department"]` **[V]**.

Example URLs that work today:

```
# general catalogue page
https://www.woolworths.co.nz/api/v1/products?target=browse&page=1&size=100

# one department (Fruit & Veg)
https://www.woolworths.co.nz/api/v1/products?target=browse&dasFilter=Department%3B1%3BFruit%20%26%20Veg%3Bfalse&page=1&size=120
```

No `ddKey` or other session key is needed.

## (b) Catalogue size & pagination limits

- Unscoped `target=browse` reports `totalItems: 10000` regardless of sort **[V]** — a hard
  relevance-window cap, *not* the real catalogue size. Pagination past it returns empty
  pages: page 99×100 (=items 9801–9900) still full; page 120×100 → empty, `totalItems:-1`
  **[V]**.
- Real breadth via department facets on the browse response **[V]** (Glenfield, 2026-08-24):
  sum of department counts ≈ **22,837**, but products are cross-listed in multiple
  departments, so the unique-SKU catalogue is estimated **≈18–22k SKUs**.
  Fruit & Veg 717 · Meat & Poultry 620 · Fish & Seafood 117 · Fridge & Deli 2778 · Bakery 710
  · Frozen 996 · Pantry 6517 · Beer & Wine 1568 · Drinks 1655 · Health & Body 3973 ·
  Household 1972 · Baby & Child 636 · Pet 602.
- **Every single department is far below the 10k cap** → a per-department crawl enumerates
  the whole catalogue with no gaps: 13 × ⌈count/120⌉ requests at `size=120`
  (~13–14 requests/page-size-120 per store if counts hold; ~190 requests at size=100).
- Specials subset: 4811 SKUs at Glenfield, 3683 at Howick (same day) **[V]**.
- Caveat [I]: department facet counts are computed on the unscoped browse result set; if the
  cap ever clipped a department count, the sum would under-count. Currently no department is
  anywhere near 10k, so this is theoretical.

## (c) Multi-store binding — VERDICT: anonymous multi-store IS possible

### What binds a response to a store

Every `/api/v1/products` response carries `context.fulfilmentStoreId` (+ address, method,
delivery area). Binding is **server-side session state keyed by cookies**
(`ASP.NET_SessionId` etc.), not by any documented request parameter **[V]**:

- Query params `storeId=…` / `fulfilmentStoreId=…` are ignored (store stays 9171) **[V]**.
- Completely cookieless requests still get the same default store (Glenfield / fulfilment
  store 9171 "WW Greville Road"), so the default is server-assigned, not cookie-derived
  **[V]**.

### The store switch flow (all verified live end-to-end)

1. **Store metadata:** `GET /api/v1/fulfilment/stores/{fulfilmentStoreId}` →
   `{id, name, addressId, active, pickupAddress:{addressId, address, name}}` **[V]**
   (e.g. 9171 → "WW Greville Road", pickup `addressId` 3105636).
   Note: this endpoint 500s for closed/inactive store ids (e.g. 9163 "Glenfield Woolworths"
   is closed; 9001 "ZClosed CD Oamaru" returns `active:false` metadata without pickup info)
   **[V]**.
2. **Switch:** `PUT /api/v1/fulfilment/my/pickup-addresses` with JSON body
   `{"addressId": <pickupAddress.addressId>}` → 200, response echoes the new context **[V]**.
   This matches the SPA's `changeSelectedPickupStore()` which PUTs `{addressId}` to the
   `postPickupAddress` endpoint (`fulfilment/my/pickup-addresses`) **[B]**.
3. **Effect:** subsequent `/api/v1/products` responses in the same cookie session report the
   new `fulfilmentStoreId` and, crucially, **store-specific prices and specials sets** **[V]**:
   - Session A (no switch): store **9171** Glenfield — specials facet 4811;
     milk 3L sku 282768 = $7.19/$7.19.
   - Session B (PUT Howick `addressId` 1237277): store **9024** "Woolworths Howick" —
     specials facet **3683**; same milk SKU = **$7.23 original / $7.19 promo**.
     Of 95 overlapping SKUs on browse page 1, 94 identical, 1 different (the milk above).
4. There is also a courier/suburb variant (`PUT /api/v1/fulfilment/my/methods/courier`,
   then `PUT /api/v1/fulfilment/my/suburbs/{suburbId}`) seen in the bundle **[B]** —
   not probed live; the pickup-store path above is sufficient.

### Store directory (finding all stores)

The store-finder uses a separate service (from `assets/settings.json` **[B]**):
`siteLocationApiUrl = https://api.cdx.nz/site-location`

- `GET https://api.cdx.nz/site-location/api/v1/sites/search?q=glenfield` →
  `{"items":[{"id":"9163","name":"Glenfield Woolworths","suburb":"Glenfield","state":"AUK",
  "postcode":"629","facilities":[…]}]}` **[V]** — ids here are *site* ids; closed sites can
  500 on step-1 metadata, so treat failures as "not crawlable".
- Lat/long search also exists: `…/api/v1/sites?latitude=..&longitude=..&maxResults=N`,
  and v2 detail `…/api/v2/sites/{id}?division=countdown…` **[B]** — v2 detail was broken
  server-side during probing (500 "Could not find file /app/store_info_countdown.json") **[V]**.
- Practical approach: iterate `fulfilmentStoreId`s around known ranges (90xx/91xx) hitting
  `GET /api/v1/fulfilment/stores/{id}`, keep `active:true && pickupAddress.addressId`.
  Sampled: 8023→404, 9001→closed, 9024→active Howick, 9076→500, 9163→500(closed),
  9171→active Greville Road **[V]**.

### N-store coverage options

| Option | Cost | Notes |
|---|---|---|
| One cookie-session per store, kept alive; switch via PUT when rotating | 1 PUT per store per cycle | **Verified working anonymously.** Sessions are just `Set-Cookie` jars from any first GET; no login. |
| Re-switching a single session between stores | 1 PUT per rotation | Works too (binding follows latest PUT) **[V]**, but you must never interleave pages of two stores mid-collection — the existing adapter already asserts store stability during collection, keep that. |
| Per-request store parameter | — | **Does not exist** (verified ignored). |

## (d) Bytes / latency (cost model)

Measured this session (gzip off, full JSON bodies) **[V]**:

| Request | Bytes | Latency |
|---|---|---|
| browse size=100 page 1 (full payload) | ~189 KB | 0.74 s |
| browse size=100 page 99 | ~181 KB | 0.99 s |
| specials size=100 (typical page) | ~180 KB | ~0.8 s |
| browse size=24 | ~50 KB | 0.27–0.60 s |
| browse size=5 | ~17.5 KB | ~0.25 s |
| error/empty responses | 0.1–5 KB | <0.2 s |
| `sort=PriceAsc` unscoped (server does more work) | ~50 KB @24 | **3.4 s** |

Latency is dominated by server-side work (price-sorted queries took 3–10× longer); bytes
scale with `size`.

### Daily full-catalogue estimate (single store)

- Per store: ~18–22k SKUs ÷ 120/page ≈ **155–185 pages** (size=120, per-department) or
  ~230+ pages at size=100. At ~185 KB/page → **~30 MB/store/day** raw JSON.
- Time at 2.5 s/request pacing: ~8–10 min/store of pure crawling; add margin and it's
  comfortably schedulable hourly if desired, daily certainly.
- N stores scales linearly: e.g. 10 stores ≈ 300 MB/day, ~1.5–2 h crawl time at polite pacing.
- Compression: sending `accept-encoding: gzip` (Node fetch does by default) should cut wire
  bytes roughly 5–10×; figures above are uncompressed body sizes.

## Risks

- **Bot protection:** Akamai (`ak_bmsc`, `bm_sz` cookies) + a fingerprinting script tag are
  present on every response **[V]**. Plain `fetch` worked throughout this session with
  constant, honest headers and ≥2 s spacing, but volume spikes, header anomalies, or TLS
  oddities could trigger challenges. Mitigations: keep the existing adapter header set, keep
  pacing ≥2 s/request, reuse sessions instead of re-handshaking per request, back off on
  403/429. Note the repo already uses `curl`-via-`execFile` for The Warehouse for similar
  reasons.
- **Undocumented API:** paths/payloads can change silently (the v2 site-detail endpoint was
  literally broken server-side during this research). Wrap discovery calls in try/catch and
  alert on shape drift (`context.fulfilment.fulcilmentStoreId` missing etc.).
- **Closed-store traps:** `fulfilment/stores/{id}` returns HTML 500 for some closed sites;
  validate `active === true` before switching.
- **ToS / legality:** Woolworths NZ's terms, like most retailers', restrict automated access
  and scraping beyond personal use; robots.txt disallows API paths. This is an
  archival/research project — keep request rates low, identify honestly (custom UA), don't
  republish copyrighted imagery, and expect to be blocked eventually; degrade gracefully to
  the single default store if switches start failing.

## Recommended approach

1. **Keep the existing specials collector as-is** (`target=specials&useRankedSpecials=true`)
   — unchanged behavior, now understood as a special case of the browse API.
2. **Add full-catalogue collection as a per-department browse crawl:**
   - seed departments from `GET /api/v1/products/departments` (or the `dasFacets` on any
     browse response);
   - for each department: `target=browse&dasFilter=Department;<id>;<name>;false&sort=PriceAsc
     &page=N&size=120` until `page > ceil(totalItems/120)` (price sort gives deterministic,
     stable ordering so pagination can't skip/duplicate across runs);
   - dedupe SKUs across departments (cross-listing is common).
3. **Multi-store:** build one cookie-jar session per target store:
   bootstrap (any GET) → discover `pickupAddress.addressId` via
   `GET /api/v1/fulfilment/stores/{id}` → `PUT /api/v1/fulfilment/my/pickup-addresses` once →
   verify `context.fulfilmentStoreId` before each run (reuse the adapter's existing
   store-stability assertion). Store directory discovery by scanning id ranges with the
   metadata endpoint, keeping only `active:true` stores.
4. **Cost control:** size=120 pages, gzip on, ~2.5 s/request ⇒ ~10 min/store/day for the
   full catalogue; persist ETags/nothing — the API doesn't advertise conditional support, so
   plan for full pulls.
5. Extend `WoolworthsClient` minimally: expose `listProducts({target, dasFilter, sort, page,
   size})`, `switchStore(addressId)`, and `getStoreMeta(id)` alongside the existing
   `listDeals()`; reuse `fetchWithRetry` and the same header block.

---

### Probe log index (kept out-of-repo, available on request)

Phases: p1 baseline/no-target/target=browse · p2 sizes/deep-pages/store-param-guesses ·
p3 sort/department-slugs/search-target · p4 dasFilter decode+verify · p5-p6 store-meta &
wrong-addressId PUTs · p7-p12 store-directory discovery (sites endpoints) ·
p13-p15 correct switch flow + cross-store price comparison.
Key artifacts: `p1-summary.json` … `p15-summary.json`, `04-browse-size100.json`,
`114-browse100-newstore.json` equivalents, `settings.json` (SPA config).
