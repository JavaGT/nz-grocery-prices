# Scraper upstream API documentation

One doc per upstream API surface the scrapers use. Every claim is derived
from code + test fixtures — never from live retailer calls (repo rule) —
and load-bearing statements carry `file:line` citations verified against
the commit that wrote them (they will drift as adapters evolve).

Start here, then open the doc for the surface you're touching.

## Bespoke grocery adapters (`src/adapters/` + `scripts/`)

| Doc | Covers | Entry points |
|---|---|---|
| [woolworths.md](woolworths.md) | Woolworths NZ web API, cookie session (`WOOLWORTHS_COOKIE`), deals + breadth | `npm run woolworths` |
| [foodstuffs.md](foodstuffs.md) | Foodstuffs platform: New World + PAK'nSAVE, web (Algolia-backed) and mobile-app backends, `--all-stores` walk | `npm run newworld`, `npm run paknsave` |
| [freshchoice.md](freshchoice.md) | FreshChoice storefront JSON API, `FRESHCHOICE_ORIGIN`/`FRESHCHOICE_STORE_NAME` overrides | `npm run freshchoice` |
| [warehouse.md](warehouse.md) | The Warehouse — SFCC `updategrid` over a `curl`/`execFile` transport (anti-bot TLS) | `npm run warehouse` |

## Retailer campaign platform families (`retailers/_lib/`)

| Doc | Covers |
|---|---|
| [platform-storefronts.md](platform-storefronts.md) | Shopify `products.json` (454 retailers), Magento GraphQL, SFCC `updategrid`, WooCommerce Store API, HTML-grid fallback |
| [platform-search.md](platform-search.md) | Algolia, Constructor.io, eStar category JSON, Next.js `__NEXT_DATA__`, schema.org JSON-LD PDPs |
| [shared-transport.md](shared-transport.md) | `http.js` seams, `curl-transport` argv construction, `fetch-with-retry` defaults, observation/runner pipeline contracts |

## Conventions

- Secrets are referenced by env-var name only; values are never quoted.
- Each doc's failure-modes section doubles as the hardening log for that
  surface.

## Hardening snapshot (2026-09-07)

- `8d0edaf` foodstuffs — NaN-guarded token cache, validated paged
  envelopes (was silent one-page truncation), named mobile-auth errors.
- `bffec0e` search/transport — curl `execFile` wedge-guard timeout +
  bounded errors with exit/body detail, constructor-io wired through the
  timeout-honoring `getJson`, parsers tolerate non-string input.
- `2132560` storefronts — Magento 200-HTML WAF bodies fail named, HTML
  entity decoder range-guarded.
- `e13abba` woocommerce — WP REST error bodies fail with a named error
  instead of "items is not iterable".
- `0c93a4d` woolworths — unbounded deals paging stopped, unread error
  bodies cancelled, optional `name` never rendered as "undefined",
  secrets-hygiene test pinning cookie handling.
- `14c8a93` freshchoice/warehouse — `execFile` timeout backstop behind
  curl `--max-time`, bounded curl-failure errors, entity-decoder range
  guard, 20 MiB body cap on HTML reads.

## Full-claim audit pass (2026-09-08)

Every doc re-verified claim-by-claim against current code (~60 stale
citations refreshed across the four bespoke docs; all 153 platform-doc
citations re-checked in bounds and semantically). Hardening landed with
focused tests:

- Bespoke adapters — woolworths deals envelope validated (`assertDealsEnvelope`)
  + non-array `departments` tolerated; foodstuffs `productId`/promotions/
  `listStores` payload guards; foodstuffs-mobile cancels unread error bodies
  on all three error paths; freshchoice parser/`pageCount` non-string guards;
  freshchoice-breadth cancels error bodies; warehouse stops on a zero-tile
  page (lying grid header paged forever under `--pages all`).
- Platform families — estar skips null/junk embedded items; html-grid
  validates its profile at construction (not mid-walk) and tolerates a
  missing `name` pattern list; magento drops null/junk category-tree entries;
  woocommerce threads its `retry` option through to `fetchWithRetry`
  (previously silently dropped).
