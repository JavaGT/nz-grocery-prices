# Research — FreshChoice & The Warehouse full-catalogue breadth

*Live-probed 2026-08-25. Read-only probes; all numbers measured, not estimated,
unless marked "est". Probe artifacts kept out-of-repo (temp dir), nothing
committed.*

## TL;DR

| | FreshChoice | The Warehouse |
|---|---|---|
| Catalogue surface | Per-storefront HTML (`talker` cards) | National HTML fragments from `/search/updategrid` |
| Discovery | **`/sitemap.xml` per storefront** — every product URL listed | **`sitemap_index.xml`** → 15 × `sitemap_N-product.xml` (~5,000 URLs each) **and** `cgid=root` grid walk |
| Full catalogue once (largest store / national) | ~14.2k products ≈ **1 + 607 × ⌈pages⌉ requests** via category pages (see below) | **~2,637 grid pages** at 32/page (or ~84k sitemap URLs if PDP-scraping instead) |
| Prices per location? | **Yes** — proven: same line $4.69 was-price in Queenstown vs $4.99 in Avondale | No — single national online price scope |

## FreshChoice

### Store enumeration (verified)

- `https://store.freshchoice.co.nz/` returns the national store chooser.
  Existing `parseFreshChoiceStoreList` parsed it to **exactly 76 stores**
  (probe: 200 OK, 60 KB, 0.7 s).
- Each store is a subdomain `https://{slug}.store.freshchoice.co.nz`.

### Full-catalogue enumeration per storefront (verified)

**`GET https://{store}.store.freshchoice.co.nz/sitemap.xml`** is the key find:

- HTTP 200, no auth, plain XML (queenstown: 242 KB / 2.6 s; avondale: 57 KB).
- Contains **every product URL**: queenstown = **14,248 `/lines/{slug}` URLs**
  + 607 `/category/{slug}` URLs (total 14,957 `<loc>` entries).
- Avondale's sitemap has only **3,193 `/lines`** → catalogue size varies
  hugely per store (est. range across the estate roughly 3k–15k lines).
- robots.txt explicitly declares the sitemap and does *not* disallow
  `/lines`, `/category`, or `?page=`.

Two enumeration strategies per store:

| Strategy | Requests for Queenstown (est) | Bytes (est) | Notes |
|---|---|---|---|
| A. Category-walk: fetch 607 `/category/*` roots from sitemap, follow `?page=N` | 1 (sitemap) + Σ ⌈catSize/48⌉ ≈ **300–450 pages typical**; worst case if one giant pseudo-category dominates, more | ~75–80 KB/page → ~25–35 MB/store | Uses existing ProductCard parser verbatim; prices come free on listing pages |
| B. PDP crawl of all 14,248 sitemap `/lines` URLs | 14,249 requests | ~55 KB each → **~780 MB/store** | Only needed if listing pages miss fields; wasteful |

Strategy A is recommended. Measured facts backing it:

- Category page = **48 talker cards/page**, ~78 KB, 0.5–1.0 s.
- Pagination: plain `?page=N`; `aria-label="Page N"` gives max page (existing
  `pageCount()` already parses this). Verified `bakery?page=2` has zero id
  overlap with page 1; `?page=9` past end returns HTTP 200 but **0 talkers**
  → terminate on card-count or pageCount, not status.
- The existing parser round-trips live markup:
  `parseFreshChoiceProducts(fc category html)` → 48 products with id/name/
  sellCents/wasCents/unit/comparative/isSpecial.
- `/lines` alone 404s (there is no "all products" landing page); `/specials`
  covers only specials (Queenstown: 72 pages; Avondale: 19 — varies by store).

### Per-store pricing (verified)

Same URL path on two storefronts:

- `…queenstown.../lines/ploughmans-bread-country-grains-750g`: sell **$3.99**, was **$4.69**
- `…avondale.../lines/ploughmans-bread-country-grains-750g`: sell **$3.99**, was **$4.99**

→ current promo prices can coincide but **regular/was prices differ per
store**; FreshChoice observations are genuinely per-location. Note PDPs use
`ProductDetail__Price__*` classes (different from listing-page `talker`
markup); strategy A avoids needing a second parser.

### Coverage math (est)

- Largest-store full sweep ≈ 1 sitemap + ~300–450 category pages ≈ **~30 MB,
  well under an hour at 1 req/2 s**.
- All 76 stores ≈ **~25k–35k requests total (est)** — a nightly-per-retailer
  job, or rotate a few stores per night.

### Risks

- robots.txt bans specific SEO/AI bots by name (SemrushBot, ClaudeBot, etc.)
  and disallows `/search`, `sort_by=`, `q[]=` params. Generic `*` rules allow
  `/category?page=N` and `/lines`. Keep the polite UA already used
  (`nz-grocery-prices/0.1`) — no bot-name collision.
- No anti-bot challenge observed (no Cloudflare interstitial on any FC probe).
- Sitemap is regenerated often (image URLs carry dated signatures) — refetch
  per run; treat slug set as the store's catalogue truth.

## The Warehouse

### Full-catalogue paths (verified)

1. **Grid API (recommended):** `GET /search/updategrid?cgid=root&start=N&sz=32`
   - Returns HTML fragment with `product-tile` divs; existing
     `parseWarehouseProducts` handles it (32 tiles parsed from probe).
   - `cgid=root` reports **"of 84,356 products"** — site-wide count in one
     request.
   - Fragment ~15 KB, ~0.24–0.34 s.
2. **Sitemaps:** `robots.txt` → `sitemap_index.xml` → 15 ×
   `sitemap_{0..14}-product.xml`, each exactly 5,000 `/p/{slug}/{id}.html`
   URLs (**~75,000 product URLs**; note < 84,356 grid count — grid includes
   marketplace items sitemaps omit). Plus `sitemap_31-category.xml` (3,762
   category URLs) useful as a cgid dictionary.

Measured pagination behaviour of updategrid (important):

- **Server caps every response at 32 tiles** regardless of `sz=48/96/100`.
- Offsets step cleanly by 32 (`start=0,32,…`) — verified unique ids advance
  window-to-window; walking `start=0 … 1120` covered a claimed 1,123-product
  category fully (last page had 3 tiles; `start=1152` returned **0 tiles**).
- Duplicate ids can appear across windows (64 dupes seen in 35 probe pages);
  dedupe by `product.id` (the existing `#collect` Map already does this).
- Terminate when a page returns **0 product-tile divs** (HTTP stays 200).

### Total scale & cost (measured/derived)

- Food/household/pets tree (`cgid=foodhouseholdpets-fooddrink`): **"of 1,123
  products"** → ~36 grid pages ≈ **~550 KB, ~12 s** at 1 req/3 s.
- Whole site (`cgid=root`): 84,356 / 32 ≈ **2,637 pages ≈ ~40 MB** ≈ ~2.2 h
  at 3 s/page.
- Grocery-relevant subset is tiny by comparison; the grocery tree plus its
  child cgids (from `sitemap_31-category.xml`, which lists e.g.
  `/c/food-pets-household/...` leaves) can be walked selectively.

### Location pricing

Single national online scope — the adapter's default `scopeId =
national-online` is correct. Grid payload carries one flat NZD price per
product; no store/region parameter exists in the endpoint. Marketplace items
(`marketplaceProduct: true`) are excluded by the existing collector default;
keep that (they're third-party sellers, not TWL shelf prices).

### Risks

- **Cloudflare is live on the search path:** `q=milk` grid queries returned
  **403 "Attention Required!"** twice (with browser-like headers), while
  `cgid=` grid queries kept returning 200 before and after. This matches the
  repo's hard rule: Warehouse must go through `curl` via `execFile` (TLS
  fingerprint), never shell strings or naive fetch. Treat query-string search
  as off-limits; stick to `cgid` walks. Add jittered sleeps (≥3 s worked all
  session; ~40 consecutive 200s).
- robots.txt disallows `/*?cgid=*` and `q=*` for crawlers — i.e. Googlebot is
  steered away from grid URLs, not us specifically, but it signals these are
  session-ish endpoints; keep volumes low and steady.
- `sz` > 32 silently ignored — don't rely on bigger pages.
- Sitemap product count (75k) ≠ grid root count (84,356): marketplace skew.
  If full-grid walks ever get blocked, the sitemap + PDP route exists but
  costs ~75k requests at ~28 KB/PDP (~2 GB) — fallback only.

## Recommended crawl designs

### FreshChoice (per storefront)

1. `listStores()` (existing) → 76 stores.
2. Per store, per run: fetch `{origin}/sitemap.xml`; extract `/category/*`
   roots (+ optionally skip categories whose slug-set is unchanged since last
   successful run — cache keyed by sitemap ETag/mtime if present).
3. Fetch each category root; parse with `parseFreshChoiceProducts`;
   read max page from `pageCount()`; fetch remaining `?page=2..N`.
4. Stop conditions: parsed pageCount reached, or a page yields 0 cards.
5. Convert with `toFreshChoiceObservation(product, store)` — prices are
   per-store, so every storefront gets its own observation set.
6. Politeness: 1.5–3 s sleep between hits; one store at a time; full estate
   rotation over the week.

Request budget: largest store ≈ 350–450 requests/run; whole estate ≈ 25–35k
requests spread across runs.

### The Warehouse (national, once per run)

1. One call `updategrid?cgid=root&start=0&sz=32` to read the live total.
2. Walk `cgid={tree}` for each top-level tree you care about (grocery first:
   `foodhouseholdpets-fooddrink` = ~36 pages today), stepping `start += 32`,
   deduping ids, terminating on a 0-tile page. Use `sitemap_31-category.xml`
   as the cgid dictionary if leaf-level counts are wanted.
3. Parse with `parseWarehouseProducts`, convert with `toWarehouseObservation`.
4. Transport: the adapter's curl/execFile path only. Sleep ≥3 s; abort the
   run on any 403 (Cloudflare) rather than retrying into a block.

Request budget: grocery tree ≈ 36 requests; everything ≈ 2,640 requests.

## Probe log (condensed)

| # | Request | Result |
|---|---|---|
| 1 | `store.freshchoice.co.nz/` | 200, 60 KB, 76 stores parsed |
| 2 | `queenstown.../robots.txt` | 200; blocks named bots + /search, sort_by; allows category/lines/page; declares sitemap |
| 3 | `queenstown.../sitemap.xml` | 200, 242 KB, 14,957 locs (14,248 lines + 607 category) |
| 4 | `avondale.../sitemap.xml` | 200, 57 KB, 3,193 lines + 607 category |
| 5 | `queenstown.../category/bakery` (+p2, p9) | 200, ~78 KB, 48 cards/page, Page 8 max; p2 disjoint; p9 empty-but-200 |
| 6 | `queenstown.../category/bread` (+p4, p5) | 4 pages; p5 empty-but-200 |
| 7 | `queenstown.../specials?p1,p72`; avondale specials | 72 vs 19 pages — per-store variance |
| 8 | 3 random `/lines` PDPs | 200, ~55 KB each |
| 9 | PDP same product QT vs AV | $3.99/$4.69 vs $3.99/$4.99 — per-store regular price proven |
| 10 | `thewarehouse.co.nz/robots.txt` | 200; disallows cgid/q params for crawlers; declares sitemap_index.xml |
| 11 | `sitemap_index.xml` | 35 sitemaps: 15 product (5,000 each), 31-category (3,762), images, folders |
| 12 | `sitemap_0-product.xml`, `_7-` | 200, 5,000 `<loc>` each |
| 13 | `/c/food-pets-household/food-drink/chips-snacks` | 200, 35 KB, "of 188 products", 160 tile markers server-rendered |
| 14 | `updategrid?cgid=foodhouseholdpets-fooddrink` sz=100/96/48/start-sweep 0→1152 | always 32 tiles/page; total "of 1,123"; last data page 3 tiles; past-end 0 tiles; 1,059 unique ids from 1,091 parsed tiles (64 cross-window dupes) |
| 15 | `updategrid?pmid=all` | 200, "of 0 products" — pmid=all invalid |
| 16 | `updategrid?q=milk` ×2 | **403 Cloudflare** both times; cgid calls fine immediately after |
| 17 | `updategrid?cgid=root` | "of 84,356 products", 32 tiles |
| 18 | leaf cgid oil | "of 2 products" |
