# Woolworths NZ upstream HTTP API

Reference for what the Woolworths collector actually sends and consumes.
Everything here is derived from code and existing tests/fixtures — no live
calls were made to write it.

| Piece | Path |
|---|---|
| Adapter (client + domain mapper) | `src/adapters/woolworths.js` (`WoolworthsClient`, `toWoolworthsObservation`) |
| Public type contract | `src/adapters/woolworths.d.ts` (re-exported as `nz-grocery-prices/woolworths`, `package.json:25-28`) |
| Shared retry/timeout/JSON helper | `src/adapters/fetch-with-retry.js` (`fetchWithRetry`, `parseJsonResponse`) |
| Deals/archive CLI | `scripts/woolworths.js` — entry command `npm run woolworths` (`package.json:54`) |
| Full-catalogue breadth collector | `scripts/woolworths-breadth.js` (run directly, or via `npm run breadth:nightly` → `scripts/breadth-pilot-nightly.sh:159`) |

## 1. Overview

One backend: Woolworths NZ's own web app API at
`https://www.woolworths.co.nz` (`DEFAULT_ORIGIN`,
`src/adapters/woolworths.js:3`). All requests are plain GETs against
`/api/v1/products*` with a fixed browser-ish header set; there is no auth
handshake, no token mint, and no pagination envelope beyond `page`/`size`
query params. The anonymous site answers with its default (Glenfield)
fulfilment store; a cookie captured from a logged-in browser session
re-targets the store (see §3).

`toWoolworthsObservation` (`src/adapters/woolworths.js:48-123`) maps one API
product into the shared `PriceObservation` domain shape
(`src/domain/observation.d.ts`), and is the single place wire fields are
interpreted.

## 2. Endpoints

Base `{origin}` = `https://www.woolworths.co.nz` by default; every method is
GET; all calls go through `#request` → `fetchWithRetry` +
`parseJsonResponse` (`src/adapters/woolworths.js:145-167`).

| Purpose | Method | URL | Notable query params |
|---|---|---|---|
| Specials listing (deals) | GET | `{origin}/api/v1/products` | `target=specials`, `useRankedSpecials=true`, `page` (1-based), `size` (default 100) (`listDeals`, `src/adapters/woolworths.js:170-178`) |
| Browse/search listing (breadth) | GET | `{origin}/api/v1/products` | `target=browse` (default), `page`, `size`, optional `dasFilter`, `sort`, `search`, `useRankedSpecials` — set only when provided (`listProducts`, `src/adapters/woolworths.js:180-190`) |
| Department taxonomy | GET | `{origin}/api/v1/products/departments` | none (`listDepartments`, `src/adapters/woolworths.js:192-194`) |

There is also a non-API product URL built for the archive's `source.url`
(never fetched by the collector):
`{origin}/shop/productdetails?stockcode={sku}&name={slug|name|"product"}`
(`src/adapters/woolworths.js:122`).

## 3. Auth & headers

No tokens or login flow. Every request carries this fixed header set
(`src/adapters/woolworths.js:147-154`):

- `accept: application/json`, `content-type: application/json`
- `referer: {origin}/shop/specials`
- `user-agent: nz-grocery-prices/0.1` (`DEFAULT_USER_AGENT`,
  `src/adapters/woolworths.js:4`; overridable via constructor option)
- `x-requested-with: OnlineShopping.WebApp` — what makes the API answer
  JSON instead of the SPA shell.

Optional session cookie: the CLI scripts construct the client with
`cookie: process.env.WOOLWORTHS_COOKIE`
(`scripts/woolworths.js:7`, `scripts/woolworths-breadth.js:123`). The
constructor merges it as the request `cookie` header
(`src/adapters/woolworths.js:141`). Its only documented effect is to reuse
another fulfilment store selected in your browser; without it the anonymous
session defaults to its own store (help text, `scripts/woolworths.js:42-43`).

Secrets handling: `WOOLWORTHS_COOKIE` lives in the gitignored
`collector.env`; it is read from the environment at process start, attached
to the request headers, and never logged. Thrown errors name the path,
status, content-type, and a body prefix only — a regression test pins that
the cookie value never appears in an error message
(`test/adapters/woolworths.test.js`, "never leaks it into error messages").
Extra headers can be injected via the `headers` client option; an explicit
`cookie` option wins over them (`src/adapters/woolworths.js:140-141`).

## 4. Request params

`listDeals` / `listProducts` options → query params
(`src/adapters/woolworths.js:170-190`):

| Option | Type | Default | Notes |
|---|---|---|---|
| `page` | number | `1` | 1-based |
| `size` | number | `100` | page size |
| `target` | string | `"specials"` (deals) / `"browse"` (products) | selects the listing mode |
| `useRankedSpecials` | `"true"` | deals: always; products: optional | ranked specials ordering |
| `dasFilter` | string | — | facet filter; breadth uses `Department;{id};{label};false` (`scripts/woolworths-breadth.js:95-97`) |
| `sort` | string | — | breadth uses `PriceAsc` for deterministic coverage (`scripts/woolworths-breadth.js:157`) |
| `search` | string | — | free-text search |

Client-level transport options (`src/adapters/woolworths.js:134-143`):
`origin`, `userAgent`, `cookie`, `headers`, `fetch` (injectable test seam),
`signal` (caller abort), `timeout` (ms, default 15000), `retry` (policy
object or `false` — see §7).

CLI flags: `scripts/woolworths.js` takes `--pages <n|all>` (default `1` for
deals, `all` = unbounded for feed/archive), `--size <n>` (default 100),
`--file <jsonl>` for archive (default `data/prices.jsonl`), `--json`
(`scripts/woolworths.js:51-56`). The breadth script takes `--file`
(default `data/breadth-pilot-ww.jsonl`), `--delay-ms` (3000), `--size`
(120), `--max-pages` (300 per department), `--budget` (400 total HTTP
requests), `--force-live` (`parseArgs`, `scripts/woolworths-breadth.js:36-78`).

## 5. Response shape (fields the adapter consumes)

Envelope (`#request`, `src/adapters/woolworths.js:162-166`):

| Field | Type | Use |
|---|---|---|
| `isSuccessful` | boolean | `false` → throw (see §8) |
| `context.fulfilment.fulfilmentStoreId` | string \| number | store identity (`getStore` `src/adapters/woolworths.js:196-208`; `collectDeals` `:221-232`) |
| `context.fulfilment.address` | string (optional) | store display name/address |
| `products.items` | array | page of products (`:234`) |
| `products.totalItems` | number (optional) | drives page-count math (`:244`; breadth `scripts/woolworths-breadth.js:179`) |
| departments payload | array, or `{departments[]\|items[]}` | breadth accepts all three shapes (`scripts/woolworths-breadth.js:81-85`) |

Per product in `products.items` — only these are read by
`toWoolworthsObservation` (`src/adapters/woolworths.js:48-123`):

| Field | Type | Maps to |
|---|---|---|
| `sku` | string \| number | required; product/store ids, dedupe key |
| `name` | string (optional) | `product.name` (size appended when not already contained, `:36-46`); missing/blank stays absent |
| `brand`, `barcode`, `slug` | string (optional) | `brand`, `gtin` (from barcode), source URL slug |
| `price.originalPrice` / `price.salePrice` | number | `regularCents` / `promoCents` or `memberCents` (dollars → cents) |
| `price.isSpecial`, `price.isClubPrice` | boolean | promo vs member-price classification (club wins, `:56-57`) |
| `productTag.tagType` | `"IsSpecial"` | alternate specials signal (`:57`) |
| `price.savePrice`, `price.savePercentage` | number | `promotion.saveCents` / `savePercent` |
| `price.promotionStartDate` / `promotionEndDate` | string (date) | `promotion.startsAt` / `endsAt`, promotion id parts |
| `size.volumeSize` | string | name suffix; `size.cupPrice` (number) + `size.cupMeasure` (string) → `price.comparative` |
| `departments[]` | `{name: string}[]` | `product.categories` (absent when `departments` is missing or not an array) |
| `images` | object | deep-cloned into `product.images` (`:73`) |

Products lacking `sku` or any usable price are skipped
(`toWoolworthsObservation` returns `undefined`, `src/adapters/woolworths.js:52-54`).

## 6. Pagination / enumeration strategy

- Deals (`collectDeals`, `src/adapters/woolworths.js:211-254`): offset
  paging, `page` from 1, `size` fixed. Every page's envelope is validated
  first (`assertDealsEnvelope`, `src/adapters/woolworths.js:25-38`, applied
  at `:221`): a non-array `products.items` or non-numeric
  `products.totalItems` throws a named error instead of crashing the loop
  or silently truncating to one page. The loop continues while
  `page <= totalPages && page <= maxPages`, where
  `totalPages = ceil(totalItems / size)` (`:244`); `maxPages` defaults to
  unbounded. Two safety stops: an empty page ends collection even if
  `totalItems` claims more (`:241`, guards against an inflated total
  spinning forever), and every product is deduped by `String(sku)` in a
  Map (`:235-236`). The fulfilment store must be present on every page and
  must not change mid-run (`:226-230`).
- Breadth (`runCollection`, `scripts/woolworths-breadth.js:113-210`):
  enumerates departments from the taxonomy endpoint, then pages each
  department with `target=browse` + `dasFilter` + `sort=PriceAsc`
  (`:154-160`), because unscoped browse results are capped. Cross-department
  dedupe via a `seen` Set of skus (`:169-172`); recordings flush per page
  into the pilot archive (`:174`). Coverage is bounded by `--max-pages`
  per department and a global `--budget` of HTTP requests
  (`requestPage`, `:139-147`); pages sleep `--delay-ms` (default 3000)
  between requests (`:141`). If a page returns 0 items while `totalItems`
  claims more, or a department ends at the page cap without a trustworthy
  total, the run is marked `incompleteCoverage`; exhausting the budget
  marks `budgetExhausted` — either flips `healthy: false` and the process
  exits 1 (`:178-186`, `:192-201`, `:232`).
- `assertNotLiveArchive` (`scripts/woolworths-breadth.js:25-34`) refuses to
  write breadth output to the live archive unless `--force-live`.

## 7. Timeouts, retries, rate limiting (as implemented)

All of this lives in the shared `src/adapters/fetch-with-retry.js`, used by
every grocery adapter:

- **Timeout**: per-attempt `AbortController`, default 15000 ms
  (`src/adapters/fetch-with-retry.js:156`, `:125-126`); aborts surface as
  `TimeoutError`. A caller-supplied `signal` aborts immediately and is
  never retried through (`:123`, `:129-135`, `:182`).
- **Retry policy**: GET only — POST/PUT/DELETE are never retried
  (`:161-169`). Default 3 attempts (`:171`). Retryable statuses: 429, 502,
  503, 504 (`:88-90`); retryable network errors: `TimeoutError`,
  `ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`
  (`:92-100`). Retryable-status responses have their unread body cancelled
  before sleeping (`:191`). After the final attempt the last response is
  returned as-is; the adapter's `assertOk` turns it into a thrown error
  with the final status (`src/adapters/woolworths.js:6-14`).
- **Backoff**: exponential `baseDelay * 2^attempt` (default base 1000 ms)
  capped at `maxDelay` (30000 ms), plus up to 20% jitter
  (`computeBackoffDelay`, `:116-120`). A numeric or HTTP-date `Retry-After`
  header on 429/503-style responses takes precedence and is capped at
  `maxDelay` (`parseRetryAfterSeconds`, `:102-114`).
- **Body safety**: response bodies are streamed with a 20 MiB cap
  (`MAX_BODY_BYTES`, `:10`; `readBodyText`, `:42-53`); a declared
  Content-Length over the cap is refused before any read (`:43-47`).
- **Rate limiting (outbound pacing)**: the library has no throttle — pacing
  is the breadth script's `--delay-ms` sleep between page requests
  (`scripts/woolworths-breadth.js:139-147`). The deals CLI makes
  back-to-back page requests and relies on retry + `Retry-After`
  (`scripts/woolworths.js:58`).

## 8. Failure modes

| Trigger | Behavior |
|---|---|
| Non-OK status after retries (4xx, or 5xx past the last attempt) | `assertOk` cancels the unread error body, then throws `Woolworths {path} failed: {status} {statusText}` (`src/adapters/woolworths.js:6-14`) |
| 200 with non-JSON body (e.g. WAF challenge) | `parseJsonResponse` throws naming operation, status, content-type, and a 120-char body prefix (`src/adapters/fetch-with-retry.js:55-62`, `:72-86`) |
| Body over 20 MiB (declared or streamed) | `readBodyText` refuses/caps mid-read with a labelled error (`src/adapters/fetch-with-retry.js:21-23`, `:43-47`) |
| `isSuccessful: false` in an otherwise OK payload | `Woolworths {path} returned an unsuccessful response` (`src/adapters/woolworths.js:164-166`) |
| Malformed listing envelope (non-array `products.items`, non-numeric `totalItems`) | named error from `assertDealsEnvelope` (`src/adapters/woolworths.js:25-38`) instead of an "items is not iterable" crash or NaN page math silently truncating to one page |
| Missing `context.fulfilment.fulfilmentStoreId` | `Woolworths response did not identify its fulfilment store` (`getStore` `:200`; `collectDeals` `:224`) |
| Fulfilment store changes between pages | `Woolworths fulfilment store changed during collection` (`:227-230`); breadth variant `scripts/woolworths-breadth.js:103-111` |
| Departments payload empty/malformed | `Woolworths departments response was empty or malformed` (`scripts/woolworths-breadth.js:80-93`) |
| Products missing `sku` or price | silently skipped — mapper returns `undefined` (`src/adapters/woolworths.js:52-54`) |
| Breadth budget exhausted / untrusted totals | no throw; summary `healthy: false` with `budgetExhausted` / `incompleteCoverage` flags, exit code 1 (`scripts/woolworths-breadth.js:160-165`, `:178-186`, `:232`) |
| Bad CLI args | `TypeError` from arg validation (`scripts/woolworths.js:51-56`; `scripts/woolworths-breadth.js:65-77`); breadth main catches everything and prints `{healthy: false, error}` JSON (`:234-237`) |

## 9. Pointers

- Tests: `test/adapters/woolworths.test.js` (mapper + client paging/error
  behavior over an injectable fetch), `test/adapters/fetch-with-retry.test.js`
  (retry matrix, Retry-After, timeout, body caps, JSON context errors),
  `test/woolworths-breadth.test.js` (arg parsing, dedupe, budget/coverage
  health flags).
- Related scripts: `scripts/woolworths.js` (deals/feed/archive/store CLI),
  `scripts/woolworths-breadth.js` (full-catalogue collector),
  `scripts/breadth-pilot-nightly.sh` (nightly orchestration, other
  retailers' lanes live in the same file).
- Sibling docs: `docs/apis/foodstuffs.md` (same format, two backends).
  The shared retry/JSON contract is documented once in §7 above and in the
  helper's own doc comments (`src/adapters/fetch-with-retry.js:36-41`,
  `:64-71`).
