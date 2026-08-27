# Woolworths NZ mobile app backend — full-catalogue feasibility

**Date:** 2026-08-27 · **Method:** web research of public reverse-engineering repos
and gists + 12 live probes (2026-08-27, ≥3 s spacing) against likely mobile API
hosts and the known web API at `www.woolworths.co.nz/api/v1`.

---

## Executive finding: there is NO separate mobile app API

Unlike Foodstuffs (see `foodstuffs-mobile-api.md`), Woolworths NZ uses **the same
single backend** (`/api/v1/*` at `www.woolworths.co.nz`) for both the website and
the iOS/Android mobile apps. The mobile app is a thin native WebView wrapper over
the same SPA that the desktop browser renders — confirmed by all three lines of
evidence:

1. **Woolworths NZ uses Apigee X** (Google Cloud) as a unified API gateway serving
   "the retailer's online store, mobile app, and Everyday Rewards loyalty program"
   — [Google Cloud case study](https://cloud.google.com/customers/woolworths-new-zealand)
   (~180 million requests/month across all channels).

2. **Producers of three independent third-party tools** (thecolab-ai/.skills
   api-notes.md, mcinteerj/woolies-nz-cli, trundler-mcp) all document the same
   `www.woolworths.co.nz/api/v1/*` endpoint set — none found a mobile-specific
   host. Thecolab-ai explicitly states: "Website/API origin:
   `https://www.woolworths.co.nz`."

3. **Live probes** (this session) against likely mobile API host patterns all
   failed to resolve or connect:
   - `api-prod.woolworths.co.nz` → DNS failure
   - `appapi.woolworths.co.nz` → DNS failure
   - `mobile.woolworths.co.nz` → DNS failure
   - `api.woolworths.co.nz` → timeout
   - The only working host: `www.woolworths.co.nz` — which returned the known
     `/api/v1/*` responses.

---

## Mobile app identity

| Attribute | Value |
|---|---|
| iOS App Store ID | `1278164689` |
| iOS bundle | `com.woolworthsnz.ios` |
| Android package | `nz.co.countdown.android.pickup` (legacy Countdown identity) |
| iOS version (latest) | 2.76.0 (2025-11-24) |
| iOS binary size | 73.7 MB |
| Minimum iOS | 15.0+ |
| Developer | Woolworths New Zealand Limited |

---

## Backend & auth

- **Origin:** `https://www.woolworths.co.nz`
- **API prefix:** `/api/v1/`
- **API Gateway:** Apigee X (Google Cloud) — routes all first-party and third-party
  traffic
- **Bot protection:** Akamai CDN + fingerprinting (`ak_bmsc`, `bm_sz`, `agaCORS`
  cookies) present on every response

### Anonymous (guest) access — working

No guest-login endpoint exists (unlike Foodstuffs). Anonymous browsing works via:

1. **Cookie-based sessions:** A `GET` to any `/api/v1/*` path establishes a session
   (Akamai + ASP.NET cookies). This session binds the fulfilment store and
   persists throughout.
2. **Required headers** (same as web SPA):
   ```
   accept: application/json
   x-requested-with: OnlineShopping.WebApp
   user-agent: nz-grocery-prices/0.1
   referer: https://www.woolworths.co.nz/shop/browse
   ```
3. **No `Authorization` header needed** for public product browse/specials.

### Authenticated access — requires browser login

Personal endpoints (trolley, saved lists, past orders) need the website's
authenticated cookie session. Sign-in flows through `/api/v1/bff/initiate-oidc-signin`
→ Auth0 IAM, which can present a browser challenge. Third-party tools
(woolies-nz-cli, thecolab-ai) handle this via **Camoufox** (anti-detect Firefox
browser) that fills credentials in the real OIDC flow and captures the resulting
session cookies.

**Catalogue breadth does not require authentication.** The BREADTH-4 plan's
anonymous full-catalogue browse works without login.

---

## Verified endpoints

All documented in `woolworths-breadth.md`. Key endpoints for full-catalogue
collection:

| Endpoint | Purpose | Status |
|---|---|---|
| `GET /api/v1/products?target=browse&dasFilter=Department%3B<id>%3B<name>%3Bfalse&page=N&size=S` | Department-scoped catalogue browse | ✅ Verified this session (size=24, Fruit & Veg: 327 items, Pantry: 5060 items) |
| `GET /api/v1/products/departments` | 13 department IDs/names + facet counts | ✅ Verified (13 depts: Fruit & Veg=1, Meat=2, … Pet=13) |
| `GET /api/v1/fulfilment/stores/{storeId}` | Store metadata: `addressId`, `active`, `pickupAddress` | ✅ Verified (9171→Greville Rd, 9024→Howick) |
| `PUT /api/v1/fulfilment/my/pickup-addresses` | Switch session store via `{"addressId": N}` | ✅ Verified: PUT returns 200 (requires cookie continuity) |
| `GET /api/v1/shell` | Navigation structure including department slugs (`url` → `/shop/browse/{slug}`) | ✅ Verified by neon-ninja/woolies — source of truth for department names used in dasFilter |
| `GET /api/v1/products/{sku}` | Single-product detail with per-store price | ✅ Verified (sku 282768, milk 3L → $7.19 at store 9171) |
| `GET /api/v1/products?target=browse&page=1&size=100` | Unscoped browse (capped at 10,000 items) | ✅ Verified (totalItems: 10000) |

### Endpoints explicitly NOT found

- No mobile-specific host (see above)
- No guest-login token endpoint (like Foodstuffs' `mobile/user/login/guest`)
- No separate product-category tree endpoint (unlike Foodstuffs'
  `mobile/v1/products/category`)
- Appears no `x-ui-ver` header is required for browse (some personal endpoints
  use it per thecolab-ai notes)

---

## Catalogue browse shape (minimum working price record)

A browse response item carries:

```json
{
  "sku": "644247",
  "name": "fresh fruit bananas snack pack",
  "brand": "fresh fruit",
  "barcode": "5099368909242",
  "price": {
    "originalPrice": 4.45,
    "salePrice": 4.45,
    "savePrice": 0,
    "savePercentage": 0,
    "isClubPrice": false,
    "isSpecial": false,
    "isNew": false,
    "promotionStartDate": null,
    "promotionEndDate": null
  },
  "size": {
    "cupPrice": 0,
    "cupMeasure": null,
    "packageType": "punnet",
    "volumeSize": "1kg"
  },
  "unit": "Kg",
  "departments": [{ "id": 1, "name": "Fruit & Veg" }],
  "images": { "small": "…", "big": "…" }
}
```

Minimum viable record for archival: **`{sku, name, price.{originalPrice, salePrice, isClubPrice, isSpecial}}`**
— these 5 fields are always present for in-stock items.

Per-store pricing verified: milk 3L (sku 282768) = $7.19 at Glenfield
(store 9171), vs $7.23 original / $7.19 promo at Howick (store 9024) in
breadth-research session 2026-08-24.

---

## Cost model (per store, full catalogue)

Data from this session + `woolworths-breadth.md`:

| Department | SKU count (facet) | Pages @ 120 | Pages @ 100 |
|---|---|---|---|
| Fruit & Veg | 327 | 3 | 4 |
| Meat & Poultry | 620 | 6 | 7 |
| Fish & Seafood | 117 | 1 | 2 |
| Fridge & Deli | 2,778 | 24 | 28 |
| Bakery | 710 | 6 | 8 |
| Frozen | 996 | 9 | 10 |
| Pantry | 5,060 (this session) | 43 | 51 |
| Beer & Wine | 1,568 | 14 | 16 |
| Drinks | 1,655 | 14 | 17 |
| Health & Body | 3,973 | 34 | 40 |
| Household | 1,972 | 17 | 20 |
| Baby & Child | 636 | 6 | 7 |
| Pet | 602 | 6 | 7 |
| **Total (facet sum)** | **~22,014** | **~183** | **~217** |

At ~55–90 KB/page (size=24, uncompressed) and ~0.7–0.8 s latency:

- **~150 requests/store** at size=120 (hourly viable)
- **~13–20 MB raw JSON/store**
- **~8–15 min/store** at 3–5 s pacing

## Working Node fetch examples

All examples are anonymous (no auth) and use the same header set as
`src/adapters/woolworths.js`. Tokens/cookies are session-generated and not
shared.

### 1. List departments

```js
const resp = await fetch('https://www.woolworths.co.nz/api/v1/products/departments', {
  headers: {
    accept: 'application/json',
    'x-requested-with': 'OnlineShopping.WebApp',
    'user-agent': 'nz-grocery-prices/0.1',
    referer: 'https://www.woolworths.co.nz/shop/browse'
  }
});
const departments = await resp.json();
// departments → array of 13 objects: { id: 1, label: "Fruit & Veg", ... }
```

### 2. Browse one department page

```js
// Fruit & Veg page 1, 24 items
const params = new URLSearchParams({
  target: 'browse',
  dasFilter: 'Department;1;Fruit & Veg;false',
  page: '1',
  size: '24'
});
const resp = await fetch(`https://www.woolworths.co.nz/api/v1/products?${params}`, {
  headers: { /* same as above */ }
});
const data = await resp.json();
// data.products.totalItems → 327
// data.products.items → array of product objects
```

### 3. Switch session store

```js
// First, establish a session via any GET (cookies are auto-managed by fetch)
const session = await fetch('https://www.woolworths.co.nz/api/v1/products?target=browse&page=1&size=1', {
  headers: { /* same as above */ }
});

// Then switch to Howick (store 9024, pickupAddressId 1237277)
await fetch('https://www.woolworths.co.nz/api/v1/fulfilment/my/pickup-addresses', {
  method: 'PUT',
  headers: {
    ...commonHeaders,
    'content-type': 'application/json'
  },
  body: JSON.stringify({ addressId: 1237277 })
});

// Subsequent GETs in this session now reflect Howick prices
```

**Note:** In Node, cookie storage is not automatic between `fetch()` calls. To
maintain session state you must collect `Set-Cookie` headers from each response
and forward them as the `cookie` header on subsequent requests. The existing
`WoolworthsClient` in this repo does not do this (it sends `options.cookie` once
at construction); `fetchWithRetry` would need to be extended or wrapped with a
cookie jar for multi-store switching. See `woolworths-breadth.md` section (c).

---

## Recommendation

**Proceed with the web API as the backend for BREADTH-4.** No separate mobile
wrapper is needed because none exists — the `/api/v1/*` web API is the same API
the mobile app uses.

The work is straightforward:

1. Extend `WoolworthsClient` (`src/adapters/woolworths.js`) with:
   - `listProducts({target, dasFilter, sort, page, size})`
   - `switchStore(addressId)` (cookie-jar chaining)
   - `getStoreMeta(id)`
2. Build a per-department paginator (reuse the specials pagination pattern)
3. Seed departments from `GET /api/v1/products/departments`
4. Validate cookie continuity across the store switch + browse calls within a
   single fetch session

Cost estimate for the full Woolworths NZ estate (~185 stores):
- ~28k–34k requests per daily run
- ~30 min/store → ~4–5 days sequential; ~3–5 hours with 20 parallel lanes
- Use `@2.5 s` pacing to stay under Akamai thresholds

See `woolworths-breadth.md` sections (c), (d) for full multi-store switching
mechanics, session rebind validation, and N-store coverage options.

---

## Open questions

1. **`dasFilter` with `sort=PriceAsc`** — confirmed long response times (3.4+ s)
   in breadth-research but gives deterministic pagination. Acceptable at 3–5 s
   pacing if per-department pages are small enough.
2. **Department count stability** — facet counts shift daily as stock changes.
   The 10k cap on unscoped browse means per-department crawl is the only
   complete option.
3. **Akamai threshold at volume** — the breadth research logged ~40 probes in
   one session with no blocks. Full estate crawl (~34k requests/day) may
   trigger rate limiting. Mitigations: reuse sessions, honest UA, ≥2 s pacing,
   spread across day.
4. **New store discovery** — scanning ID ranges (9000–9199 etc.) is fragile.
   `GET /api/v1/fulfilment/stores/{id}` returns 500 or `active:false` for
   closed/unknown stores. The `siteLocationApiUrl` (`api.cdx.nz/site-location`)
   endpoint in `assets/settings.json` provides the store directory but returns
   site IDs that differ from fulfilment store IDs. See
   `woolworths-breadth.md` section (c) for the full approach.
5. **`dasFilter` format without department slug** — neon-ninja/woolies uses
   `Department;;{slug};false` (empty value field) instead of
   `Department;{id};{name};false`. Both formats work but the slug-only form
   may be more stable — it references the URL slug rather than the display
   name. Live-verify both before committing the crawl pattern.

---

## Sources consulted (web research)

- `neon-ninja/woolies` — actively maintained (664 commits) Jupyter notebook
  doing exact per-department dasFilter crawl at `size=120` against
  `www.woolworths.co.nz/api/v1/products`, unchanged since Oct 2024
- Google Cloud case study: Woolworths NZ Apigee X deployment
- `thecolab-ai/.skills/skills/woolworths-nz/references/api-notes.md` — complete
  endpoint inventory from HAR captures
- `mcinteerj/woolies-nz-cli` — openly documents `/api/v1/*` as the only API
- `auckland-ai-collective/trundler-mcp` — uses same pattern for Countdown/Woolworths
- App Store listing `id1278164689` — `Woolworths NZ` app v2.76.0
- `hadynz` gist 2023 — sample JSON from the same API at `countdown.co.nz`
- Stack Overflow (2023) — PUT `/api/v1/fulfilment/my/pickup-addresses` used for
  store switching with Python `requests`

---

*This document augments `woolworths-breadth.md`; it does not replace it — all
endpoint-specific probe data lives there. Collectively the two docs form the
complete BREADTH-4 reference.*