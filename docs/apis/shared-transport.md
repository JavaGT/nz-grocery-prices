# Shared transport & campaign pipeline (`retailers/_lib`)

How campaign collectors talk to the network, and the contract every
collector's output must satisfy. The search/discovery platform adapters
themselves are documented in `docs/apis/platform-search.md`.

---

## `retailers/_lib/http.js` — fetch-based plumbing

Thin layer over the hardened seams in `src/adapters/fetch-with-retry.js`;
every campaign client inherits the same failure semantics
(`http.js:1-7`).

### Exports

- **`BROWSER_UA`** (`http.js:11-12`) — the campaign's Chrome-on-macOS
  User-Agent string. Used as the default by `estar-category.js:137`;
  other clients pass it via `options.userAgent` where the retailer needs
  it. Never set it to a bot-sounding string — several storefronts gate on
  it.
- **`assertOk(response, operation)`** (`http.js:14-17`) — throws
  `"{operation} failed: {status} {statusText}"` on any non-OK response.
  Called before body parsing in both `getJson` and `getText`.
- **`cleanHeaders(headers)`** (`http.js:19-22`) — drops `undefined`
  header values so `fetch` never sends the literal string `"undefined"`.
- **`getJson(url, options)`** (`http.js:28-39`) — GET + JSON parse:
  forces `accept: application/json` (overridable), runs
  `fetchWithRetry`, `assertOk`, then `parseJsonResponse`.
- **`getText(url, options)`** (`http.js:41-55`) — GET as text for HTML
  grids / JSONP / not-quite-JSON payloads. Deliberately sends
  `accept: text/html,application/xhtml+xml,*/*;q=0.8` — some platforms
  (CS-Cart) switch to an AJAX renderer when offered JSON
  (`http.js:46-47`).
- **`collectPages({ fetchPage, isDone, maxPages, onPage })`**
  (`http.js:62-71`) — numeric page walker (1-based) that never swallows
  fetch errors.
- **`onlineStore({ slug, scopeId, scopeName, origin, region })`**
  (`http.js:74-82`) — canonical online-store descriptor
  (`id: "{slug}:{scopeId}"`).

### Options (all clients pass these through)

`{ fetch, headers, timeout, retry, signal, operation }`. `operation` is a
human label used in every error message (e.g.
`"algolia super-liquor Products p0"`) — it names the retailer and page,
never credentials.

### Inherited failure semantics (`src/adapters/fetch-with-retry.js`)

- **Timeout:** default 15 s per attempt via `AbortController`
  (`fetch-with-retry.js:156`, `fetch-with-retry.js:122-146`); aborted
  attempts surface as `TimeoutError`.
- **Retry:** GET-only, on by default — 3 attempts after the first try,
  exponential backoff 1 s → 30 s with ±20 % jitter
  (`fetch-with-retry.js:161-171`, `fetch-with-retry.js:116-120`).
  Retryable: status 429/502/503/504 (`fetch-with-retry.js:88-90`) and
  network errors `TimeoutError`, `ECONNRESET`, `ETIMEDOUT`,
  `ECONNREFUSED`, `ENOTFOUND`, `EAI_AGAIN`
  (`fetch-with-retry.js:92-100`). An HTTP `Retry-After` header wins over
  computed backoff, capped at 30 s (`fetch-with-retry.js:102-114`).
- **Body cap:** 20 MB (`fetch-with-retry.js:10`), enforced on declared
  `Content-Length` before reading and chunk-wise while streaming
  (`readBodyText`, `fetch-with-retry.js:42-53`).
- **WAF-aware JSON errors:** a challenge page served with status 200
  fails as an error naming the operation, status, content-type, parse
  cause, and a 120-char body prefix — not a bare `Unexpected token`
  (`parseJsonResponse`, `fetch-with-retry.js:55-86`).

---

## `retailers/_lib/curl-transport.js` — subprocess transport

For retailers that fingerprint TLS (Node `fetch` 403s while curl passes
— same rationale as the warehouse adapter's `execFile` rule).

**Hard rule:** curl runs via `execFile` with an **array of args**, never
shell strings (`curl-transport.js:8-10`). Shell-string invocation would
change the TLS/HTTP fingerprint the anti-bot layer sees and reintroduce
injection risk. Sole campaign consumer today:
`retailers/_lib/sfcc-updategrid.js:13` (noel-leeming; see
`retailers/noel-leeming/README.md`).

### Exact argv construction (`curlGetText`, `curl-transport.js:47-71`)

```
curl --silent --show-error --fail-with-body --location --compressed \
  --max-time {ceil(timeoutMs/1000)} \
  [--user-agent {userAgent}] \
  [--header {Name}: {value}]... \
  {url}
```

- **Headers policy:** entries whose name lowercases (en-NZ) to
  `user-agent` are skipped from `--header` because user-agent is passed
  separately as its own flag (`curl-transport.js:55-57`).
- **Timeouts:** curl's `--max-time` (seconds, ceiling of `timeoutMs`,
  default 30000 ms) is the primary deadline; the `execFile`-level
  `timeout: timeoutMs + 2000` wedge-guard kills the process even if curl
  itself wedges (`curl-transport.js:72`).
- **Buffer:** `maxBuffer: 20 MB` (`curl-transport.js:12`), matching the
  fetch-side body cap; oversized bodies fail the promise rather than
  ballooning memory.
- **No retries:** the caller decides; the transport is single-shot.

### Failure behavior (`curl-transport.js:29-45`)

With `--fail-with-body`, an HTTP failure still puts the response body in
stdout with a non-zero exit code. Failures therefore throw an error that
names the URL, curl's exit code (or ENOENT/ENOBUFS), bounded stderr, and
a bounded (200-char) body prefix — a WAF challenge or error JSON is
visible in the error instead of being discarded
(`curlFailureError`, `curl-transport.js:29-45`). The original execFile
error rides as `cause`. Success path is unchanged: the body text is
returned as-is.

---

## Pipeline contract

### Canonical observation — `retailers/_lib/observation.js` (DOCUMENT ONLY)

Every adapter maps its retailer payload into `buildObservation(spec)`
(`observation.js:84-136`) so identity, price, and promotion derivation
have exactly one source. Required spec fields — missing/invalid means the
observation is silently dropped (`undefined`, callers `filter(Boolean)`):

- `slug: string` (retailer), `storeId: string` (default `"online"`),
  `storeName`, optional `region`/`origin`
- `retailerProductId: string` — retailer's own id
- `name: string`
- `regularCents: integer >= 0`; optional `promoCents`/`memberCents`
  (integers)

Derived/canonical output (`observation.js:106-135`):

- `product.id = "{slug}:{retailerProductId}"`,
  `product.store.id = "{slug}:{storeId}"`
- optional `brand`, `gtin`, `categories[]`, `images.primary`
- `price: { currency: "NZD", regularCents, promoCents?, memberCents? }`
- `promotion` derived from regular-vs-promo via `promotionFor`
  (`observation.js:49-69`): only on genuine discounts
  (`current < regular`), with `saveCents`/`savePercent`
- `observedAt` (defaults to now, ISO) and
  `source: { retailerProductId, adapter: slug, url? }`

Price helpers: `toCents` (`observation.js:20-26`) parses numbers and
display strings (`"$3.50"`, `"1,299.00"`); `minorUnitsToCents`
(`observation.js:33-39`) scales store-API minor units.

### Collection driver — `retailers/_lib/runner.js` (DOCUMENT ONLY)

Each retailer folder exposes a thin `collect.js`:

```js
import { runCollect } from "../_lib/runner.js";
import { RETAILER, createClient } from "./index.js";
await runCollect({ RETAILER, createClient }, import.meta);
```

`runCollect(ctx, importMeta)` (`runner.js:59-110`):

1. **Output is explicit or nothing.** Requires `--out FILE` or
   `--stdout`; otherwise prints usage and exits 2 (`runner.js:62-66`).
   Campaign collection never mutates `data/prices.jsonl` implicitly.
2. **Flag → method dispatch** (`runner.js:80-88`): `--query TERM` →
   `client.searchProducts({ query })`, `--category HANDLE` →
   `client.listCategory(handle)`, otherwise `client.collectProducts()`.
   `--max-pages` / `--page-size` pass through as client options;
   `--max-observations` slices the result runner-side;
   `--origin` overrides the retailer origin via `createClient`.
3. **Validation.** Every observation goes through the canonical
   `parseObservation` (`src/domain/observation.js`) before writing;
   rejects are counted (`runner.js:91-100`).
4. **Live-archive guard.** `assertNotLiveArchive(args.out)`
   (`scripts/lib/breadth-helpers.js:22-30`) refuses an `--out` that
   resolves to the live archive (`$ARCHIVE_FILE` or its fallback) —
   collection output can only land in a scratch/breadth file
   (`runner.js:93`). `--force` switches `--out` from append to overwrite
   (still guarded, `runner.js:94-98`).
5. **Zero-valid fails the run:** exit code 1 when nothing valid was
   produced (`runner.js:105-108`) — the backstop for silently-empty
   parses upstream.
