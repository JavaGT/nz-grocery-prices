# FreshChoice upstream HTTP APIs

Reference for what the FreshChoice collectors actually send and consume.
Everything here is derived from code and existing tests/fixtures — no live
calls were made to write it. FreshChoice runs one storefront-origin platform
per suburb: the national `store.freshchoice.co.nz` chooser page links ~76
per-store origins like `https://queenstown.store.freshchoice.co.nz`, and all
listing endpoints are plain server-rendered HTML (no JSON API).

Two layers exist:

| Layer | Module | Used by |
|---|---|---|
| Deals/search client (per store) | `src/adapters/freshchoice.js` (`FreshChoiceClient`) | `npm run freshchoice` (`scripts/freshchoice.js`) |
| Full-catalogue breadth client | `src/adapters/freshchoice-breadth.js` (`FreshChoiceBreadthClient`) | `node scripts/freshchoice-breadth.js` |

Both reuse the same parsers and observation mapper (`parseFreshChoiceProducts`,
`pageCount`, `toFreshChoiceObservation` from `src/adapters/freshchoice.js:133,50,164`).
The public type contract is `src/adapters/freshchoice.d.ts`.

## 1. Overview + entry commands

- `npm run freshchoice` → `scripts/freshchoice.js`. Subcommands: `stores`,
  `store`, `deals`, `search <query>`, `feed`, `archive`, `track`
  (`scripts/freshchoice.js:54-66`). `archive --all-stores` enumerates every
  storefront from the chooser page and archives one specials pass per store,
  `--delay-ms` between stores (default 1000, `scripts/freshchoice.js:94`).
  `--pages all` means unlimited pages; a number caps `maxPages`.
- `node scripts/freshchoice-breadth.js` — sitemap → category-walk breadth
  collector. Flags: `--store` (repeatable), `--file`, `--delay-ms` (default
  3000), `--budget` (default 800), `--min-expected-products` (default 1000),
  `--force-discovery` (`scripts/freshchoice-breadth.js:449-510`).

Env overrides (values are user secrets/config, never committed —
`collector.env` is gitignored):

- `FRESHCHOICE_ORIGIN` — replaces the default Queenstown origin
  (`scripts/freshchoice.js:37`, default `src/adapters/freshchoice.js:3`).
  It flows into `FreshChoiceClient({ origin })`, where `new URL(...)` validates
  it and the store slug/store name are derived from the hostname
  (`src/adapters/freshchoice.js:223-227`). A malformed value throws a
  `TypeError: Invalid URL` at startup — fail fast, no silent fallback.
- `FRESHCHOICE_STORE_NAME` — display-only store name override
  (`scripts/freshchoice.js:38`). It is only echoed into observation payloads;
  it never changes what is requested.
- `--origin URL` on any subcommand overrides the env value for that run
  (`scripts/freshchoice.js:37`).

## 2. Endpoints

`{origin}` is the per-store origin (default
`https://queenstown.store.freshchoice.co.nz`).

| Purpose | Method | URL | Params |
|---|---|---|---|
| National store chooser page | GET | `https://store.freshchoice.co.nz/` (override `options.storeListUrl`) | none (`listStores`, `src/adapters/freshchoice.js:252-263`) |
| Deals / specials listing | GET | `{origin}/specials` | `page` (1-based, default 1), `q[]=special:1` (`listDeals`, `src/adapters/freshchoice.js:295-300`) |
| Product search | GET | `{origin}/search` | `q` (required, trimmed), `page` (1-based) (`searchProducts`, `src/adapters/freshchoice.js:302-307`) |
| Sitemap (breadth discovery) | GET | `{origin}/sitemap.xml` | none (`fetchSitemap`, `src/adapters/freshchoice-breadth.js:120-140`) |
| Category listing page (breadth) | GET | `{origin}{categoryPath}` + `?page={n}` when `page > 0` | zero-based `page`; page 0 is the bare URL (`fetchCategoryPage`, `src/adapters/freshchoice-breadth.js:149-160`) |

Breadth origins are pinned to `*.freshchoice.co.nz`: `assertFreshChoiceOrigin`
rejects non-https and off-apex hosts before any fetch, because store origins
come from the (untrusted) chooser-page scrape (`src/adapters/freshchoice-breadth.js:50-68`).

## 3. Auth & headers

- No auth. No cookies, no tokens — the storefront is public HTML.
- Every client request sends `accept: text/html,application/xhtml+xml` and
  `user-agent: nz-grocery-prices/0.1` (default, `src/adapters/freshchoice.js:5`),
  plus any caller-injected headers last (`src/adapters/freshchoice.js:281-284`).
  The sitemap request sends `accept: application/xml,text/xml`
  (`src/adapters/freshchoice-breadth.js:125-128`).
- No secrets are placed in headers, URLs, or error messages.

## 4. Request params

- `page` (deals/search): 1-based; appended only when defined
  (`src/adapters/freshchoice.js:274-276`). Values are stringified into the
  query string via `URLSearchParams`, so no manual escaping is needed.
- `q` (search): free-text query; blank/whitespace queries throw `TypeError`
  (`src/adapters/freshchoice.js:303`).
- `q[]=special:1` (deals): platform query flag selecting the specials facet.
- `categoryPath` (breadth): `/category/...` path taken verbatim from the
  sitemap's `<loc>` entries; breadth pages are 0-based with `?page=N` for
  N ≥ 1 (`src/adapters/freshchoice-breadth.js:152`).
- `maxPages` (client options): local cap on pagination; default unlimited.
- `delayMs` (breadth client): minimum gap between completed requests, applied
  inside the client (`#pace`, `src/adapters/freshchoice-breadth.js:95-101`).

## 5. Response shape (consumed fields only)

All bodies are HTML/XML text; the client reads them through `readBodyText`
with a 20 MiB cap (`src/adapters/freshchoice.js:292`; cap:
`src/adapters/fetch-with-retry.js:10`).

Store chooser page → `parseFreshChoiceStoreList`
(`src/adapters/freshchoice.js:70-131`) produces per store:

| Field | Type | Notes |
|---|---|---|
| `id` | string | `freshchoice:{slug}` |
| `slug` | string | subdomain label, e.g. `queenstown` |
| `retailer` | `"freshchoice"` | constant |
| `name` | string | `FreshChoice {Name}` (prefixed if missing) |
| `address` | string, optional | joined from `StoreCard__Details` lines or the Google-Maps query fallback |
| `origin` | string | `https://{slug}.store.freshchoice.co.nz` |

When the card markup changes, a fallback scrapes bare origin links and
synthesizes `FreshChoice {Title Cased Slug}` names
(`src/adapters/freshchoice.js:112-128`).

Deals/search pages → `parseFreshChoiceProducts`
(`src/adapters/freshchoice.js:133-162`) walks `<div class="talker …" … id="line_{id}">`
blocks and consumes, per product:

| Field | Type | Source in markup |
|---|---|---|
| `id` | string | `id="line_{id}"` |
| `name` | string | `talker__name[title]`, else `talker__product-name` text |
| `path` | string | first `<a href>` before `<figure>` |
| `sellCents` | integer | first `$x.yy` in `price__sell`; products without an integer price are dropped |
| `wasCents` | integer, optional | `talker__prices__was` |
| `unit` | string, optional | `price__units` |
| `comparative` | string, optional | `talker__prices__comparison` |
| `image` | string, optional | first `<img src>` |
| `isSpecial` | boolean | `special`/`talker--Special` class |
| `classes` | string[] | tile class list |

Sitemap XML → `parseSitemapCategoryUrls`
(`src/adapters/freshchoice-breadth.js:24-37`): every `<loc>` containing
`/category/`, deduplicated, sorted. `/lines/` PDPs are ignored.

`toFreshChoiceObservation` (`src/adapters/freshchoice.js:164-214`) maps a
product + store to a `PriceObservation`: `product.id` = `freshchoice:{id}`,
`price.regularCents` = was ?? sell, `promoCents` when special,
`comparative.display` from the comparison or unit text, promotion
`saveCents`/`savePercent` when was > sell, `source.url` =
`new URL(path || /lines/{id}, origin)` (`src/adapters/freshchoice.js:211`).

## 6. Pagination / enumeration

- Deals/search client: do/while loop, page 1..n; the total page count is read
  once from page 1's `aria-label="Page N"` markers (`pageCount`,
  `src/adapters/freshchoice.js:50-53`), then iterated until exhausted or
  `maxPages` (`#collect`, `src/adapters/freshchoice.js:318-323`). Products are
  deduped by product id across pages.
- `--all-stores`: one client per storefront origin, each doing its own deals
  pagination (`scripts/freshchoice.js:105-118`).
- Breadth: per storefront, `sitemap.xml` → every `/category/*` path; each
  category is walked page 0, then continuations `?page=1..` spawned one page
  ahead until a page parses zero product cards (past-end pages still return
  HTTP 200, so termination is card-count based, not status based
  — `scripts/freshchoice-breadth.js:210-218`). Products dedupe by id across
  categories (`absorbProducts`, `scripts/freshchoice-breadth.js:87-96`).
  Progress and discovery checkpoint in `<file>.breadth-manifest.json`; page-0
  discovery entries age out after a 3-day TTL so new products on known
  categories re-surface (`discoveryFresh` usage,
  `scripts/freshchoice-breadth.js:245,261,348`).

## 7. Timeouts / retries / rate limiting

- Client (`FreshChoiceClient`): every request goes through `fetchWithRetry`
  from `src/adapters/fetch-with-retry.js` with per-attempt `timeout` (default
  15 000 ms, `src/adapters/freshchoice.js:232`) and an optional caller
  `signal`. Retry policy lives in that shared module (not owned by this
  adapter): GET only, retries on 429/502/503/504
  (`src/adapters/fetch-with-retry.js:88-90`) and retryable network errors
  (`:92-100`), exponential backoff + 20% jitter (`:116-120`) honoring
  `Retry-After` (`:102-114`), default 3 attempts (`:171`).
- Breadth client: bare injected `fetch` with `AbortSignal.timeout` (default
  15 000 ms, `src/adapters/freshchoice-breadth.js:16,129,158`); bodies read
  through `readBodyText` (20 MiB cap). Pacing: `delayMs` minimum gap between
  completed requests (client default 0; breadth script default 3000 ms,
  `scripts/freshchoice-breadth.js:49`). Circuit breaker opens after 5
  consecutive failed requests (`BREAKER_THRESHOLD`,
  `src/adapters/freshchoice-breadth.js:39`). Bootstrap fetches (sitemap, store
  list) retry in walker-level rounds: 3 rounds, 10 s apart
  (`scripts/freshchoice-breadth.js:54-55,323,554`).

## 8. Failure modes

- Non-2xx: `assertOk` throws `FreshChoice {operation} failed: {status} {statusText}`
  (`src/adapters/freshchoice.js:7-13`). The breadth client raises
  `FreshChoice sitemap fetch failed (…)` / `FreshChoice category page fetch
  failed (…)` with the URL (`src/adapters/freshchoice-breadth.js:131-136,160-165`).
- Oversized body: declared `Content-Length` over 20 MiB (or a stream that
  passes the cap mid-read) throws before/while reading
  (`src/adapters/fetch-with-retry.js:42-53`).
- Malformed character references: numeric/hex HTML entities with out-of-range
  code points are preserved verbatim instead of throwing `RangeError` from
  `String.fromCodePoint` (`decodeCodePoint`, `src/adapters/freshchoice.js:17-22`).
- Unpriced/garbled products: `parseFreshChoiceProducts` drops tiles lacking id,
  name, or an integer sell price (`src/adapters/freshchoice.js:161`);
  `toFreshChoiceObservation` returns `undefined` for the same conditions and
  the collect loop filters them out — a missing price is not an error.
- Empty store list: `archive --all-stores` throws when the chooser page yields
  no stores (`scripts/freshchoice.js:101-103`); breadth throws similarly after
  retries (`scripts/freshchoice-breadth.js:564-566`).
- Bad origin override: an invalid `FRESHCHOICE_ORIGIN`/`--origin` fails at
  client construction with a URL validation error (§1).
- Breadth-specific: circuit breaker aborts the run after 5 consecutive
  failures; budget exhaustion commits collected observations before stopping
  (`scripts/freshchoice-breadth.js:186-199`); the run reports
  `healthy: false` (exit 1) on errors, budget stops, or unique products below
  the floor unless the night ran pure-TTL skips
  (`scripts/freshchoice-breadth.js:662-671`).

## 9. Pointers

- Adapters: `src/adapters/freshchoice.js`, `src/adapters/freshchoice-breadth.js`;
  contract `src/adapters/freshchoice.d.ts`.
- Shared transport: `src/adapters/fetch-with-retry.js` (`fetchWithRetry`,
  `readBodyText`, `TimeoutError`).
- Tests: `test/adapters/freshchoice.test.js` (parsers, observation mapping,
  entity hardening, response-body cap),
  `test/freshchoice-breadth.test.js` (crawlStore waves, breaker, resume, TTL,
  end-to-end with fake transport).
- Scripts: `scripts/freshchoice.js`, `scripts/freshchoice-breadth.js`;
  helpers `scripts/lib/store-archive-loop.js`, `scripts/lib/breadth-helpers.js`,
  `scripts/lib/crawler.js`.
- Related: `docs/apis/foodstuffs.md` (same doc set), breadths run nightly via
  `npm run breadth:nightly` (see `docs/agent/command-map.md`).
