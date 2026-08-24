# Foodstuffs full-catalogue feasibility — `searchProducts` probes

**Date:** 2026-08-25 · **Method:** live probes via throwaway Node scripts in
`/private/var/folders/71/2pg61l9d535gyhsjzvyj58kc0000gn/T/opencode/fs-probe/`
(importing the real `src/adapters/foodstuffs.js` classes; no repo files touched;
~60 requests total, ≥1.1 s sleep between calls).

## Question

Can `FoodstuffsClient.searchProducts` (POST `/v1/edge/search/paginated/products`,
`filters: stores:{storeId}`, query omitted) enumerate the **full** per-store
catalogue, and what would a full-catalogue-per-day crawl cost?

## Endpoint facts (measured)

| Fact | Value |
|---|---|
| Auth | Anonymous JWT via `{webOrigin}/api/user/get-current-user`; cached by client, refreshed 60 s before expiry |
| Page size | `hitsPerPage` **max 50** (`100` → HTTP 400) |
| Pagination cap | `totalHits` clamps at **1,000**, `totalPages` at **20** (Algolia index cap). Page 19 returns 50 hits; page 20 returns `hits=0, totalPages=0` (no error) |
| True size leak | `algoliaSearchResult.facets.tobacco {"false": N}` reports the **uncapped** store catalogue size |
| Response payload | Envelope: `tobaccoProducts, products, algoliaSearchResult{facets}, totalHits, page, totalPages, hitsPerPage`. Hits carry **full pricing payloads** (`singlePrice.price`, promotions, `categoryTrees`) even though `attributesToRetrieve` asks only for IDs/categories — the server ignores it, so `toPriceObservation` maps hits directly |
| Facets returned | `brand` (capped 100 distinct), `tobacco`, `category0NI`, `category1NI` (capped 100 distinct at store level), `productFacets` (Non-GMO, Gluten Free…) |
| Filters | Free-form Algolia filter strings accepted: appending `AND category0NI:"Frozen"` works and scopes counts correctly |
| Sort orders | Envelope `sortOrder`: `{REGION}_POPULARITY_ASC` (default used by adapter) ✔, bare `PRICE_ASC` ✔, `NI_PRICE_ASC` ✘ 400, `NI_NAME_ASC` ✘ 400. `POPULARITY_ASC` ordering is **stable** across repeated calls |
| Regions | SI stores work identically with `region: "SI"` (`SI_POPULARITY_ASC` accepted); facet names stay `category0NI`/`category1NI` even for SI stores |
| Store counts | `listStores()`: **57 PAK'nSAVE**, **148 New World** |

## Measured numbers

| Store | Banner | True size (tobacco=false) | Reported totalHits | Page-0 latency | Page bytes |
|---|---|---|---|---|---|
| PAK'nSAVE Taupo (NI) | PNS | **9,445** | 1,000 (20 pages) | 328 ms (cold) / ~200 ms | 43.4 KiB |
| PAK'nSAVE Royal Oak (NI) | PNS | n/a (not captured) | 1,000 | 87 ms | 44.5 KiB |
| PAK'nSAVE Wainoni (SI) | PNS | **11,734** | 1,000 | ~200 ms | ~44 KiB |
| New World Tawa (NI) | NW | **11,175** | 1,000 | 95 ms | 43.4 KiB |
| New World Ferry Road (SI) | NW | **13,932** | 1,000 | ~200 ms | ~44 KiB |

Deep pages cost the same (page 10 @ Taupo: 335 ms, 45.8 KiB). So **blind
pagination reaches ~1,000 of ~9,400–13,900 products — roughly 8–11 % of the
catalogue.** Blind pagination is not viable for a full-catalogue archive.

### Per-store pricing proof

Page-0 sets from Taupo ∩ Royal Oak overlapped on 45 productIds; **12 had
different prices**, e.g.:

| Product | Taupo | Royal Oak |
|---|---|---|
| Bananas (5046542-KGM) | 369 | 349 |
| Telegraph Cucumber | 349 | 399 |
| NZ Beef Mince | 1849 | 1899 |
| Royal Gala Apples | 449 | 399 |

Results are genuinely store-priced, not national prices. Full-catalogue crawling
per store adds real information.

### Category facets expose an enumerable tree — yes

- `category0NI`: 14 values at Taupo (16 at NW Tawa), all counts returned.
- Counts sum **above** true size (11,749 vs 9,445) because merchandising
  pseudo-categories ("Featured", "Father's Day", "Bonus Sticker Products",
  "Pams") overlap real ones — treat facet counts as upper bounds and dedup by
  `productId`.
- Appending `AND category0NI:"X"` works. Any category with true size ≤ 1,000
  becomes **fully paginable** (reported `totalHits` becomes exact, e.g.
  "Household & Cleaning" 793/793).
- Categories above 1,000 (Pantry 2,904) need a second-level split:
  `category1NI` facets scoped to the parent return complete child lists
  (Pantry → 30 children, largest 405). All observed level-2 leaves are « 1,000,
  so two levels always suffice.
- Caveat: at store level `category1NI` is capped at 100 distinct values
  (`maxValuesPerFacet: 100` — exactly 100 came back), so children must be read
  from per-category calls, not the unfiltered call.

## Cost model — full catalogue, one day, all 205 stores

Assume avg ~11 k products/store (measured range 9.4–13.9 k), 45 KiB/page,
~200 ms/request.

**Recommended (facet-driven, two levels):**
- Pure product pages: 11,000 ÷ 50 ≈ 220/store
- Discovery overhead (1 unfiltered + ~14 cat0 + ~25 child splits + partial
  last pages): ≈ +55/store
- **≈ 275 requests/store → ~56,000 requests/day total → ~2.4 GiB/day**
- Wall clock: serial with 1 s sleep ≈ 19 h (tight); **2–4 concurrent workers ≈
  5–9 h**; no-throttle at 4 rps ≈ 4 h. Comfortably fits overnight.
- Auth: negligible — one token per client, reused.

**Blind pagination (rejected):** 205 × 20 = 4,100 requests, 180 MiB, but only
~10 % coverage per store.

## Risks

1. **Rate limits / anti-bot:** unknown limits; plain Node `fetch` worked fine
   (no TLS fingerprinting games like Woolworths). Keep ≤ ~1 rps per host with
   jitter, exponential backoff on 429/5xx, and reuse the anonymous JWT. The
   adapter already sends `analyticsTags: ["nz-grocery-prices"]` — consider an
   honest UA string.
2. **Mid-crawl drift:** popularity order is stable short-term but a multi-hour
   crawl spans promo changes → duplicates and rare gaps across page boundaries.
   Dedup by `productId`; reconcile final unique count against the store's
   `tobacco:false` count.
3. **Unattributed products:** any product lacking `category0NI`/`category1NI`
   is invisible to facet-driven crawling. The reconciliation count catches this;
   a brand-facet partition sweep (`maxValuesPerFacet` is injectable — try >100)
   is the backup enumerator.
4. **Strict server validation:** unknown `sortOrder` values and
   `hitsPerPage>50` hard-fail with 400. Stick to observed-valid values.
5. **Pseudo-category double-count** inflates naive request estimates slightly;
   harmless given dedup.
6. **`toPriceObservation` drops hits without integer prices** (rare
   multi-price/no-price edge cases) — expected, matches existing behaviour.

## Recommended crawl design

**Recursive facet drill-down, per store:**

1. Unfiltered page-0: capture facets + first 50 products; record
   `facets.tobacco.false` as the target count.
2. For each `category0NI` value (skip obvious merchandising pseudo-cats or just
   let dedup absorb them): page-0 with `AND category0NI:"…"`.
   - If true size ≤ 1,000: paginate all `ceil(n/50)` pages.
   - Else: read scoped `category1NI` children; for each child, paginate
     `ceil(child_n/50)` pages.
3. Dedup by `productId` throughout; compare unique count vs step-1 target;
   log stores where coverage < 99 %.

**Adapter change needed (small, additive):** `searchProducts` currently can't
express extra filters — the probes had to rewrite the request body via an
injected `fetch`. Add an optional `extraFilters: string[]` (joined into
`algoliaQuery.filters`) and optionally allow `maxValuesPerFacet` override.
Everything else (auth, retry, paging loop in `collectProducts`) already fits.

**Scheduling:** ~56 k requests/day across 205 stores; run overnight with 2–4
workers, one store per worker-unit, jittered sleeps. Fits the existing
local-archive runner pattern.
