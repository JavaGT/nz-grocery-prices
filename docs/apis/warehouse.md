# The Warehouse upstream HTTP APIs

Reference for what The Warehouse collectors actually send and consume.
Everything here is derived from code and existing tests/fixtures — no live
calls were made to write it. The Warehouse (thewarehouse.co.nz) runs Salesforce
Commerce Cloud (SFCC); the only listing endpoint used is the server-rendered
`/search/updategrid` grid fragment, where each tile carries a
`data-gtm-product` JSON payload.

Two layers exist:

| Layer | Module | Used by |
|---|---|---|
| Deals/search client (national online scope) | `src/adapters/warehouse.js` (`WarehouseClient`) | `npm run warehouse` (`scripts/warehouse.js`) |
| Breadth grid walker | `src/adapters/warehouse-breadth.js` (`crawlCgid`, `createCurlTransport`) | `node scripts/warehouse-breadth.js` |

The mapper `toSfccObservation` (`src/adapters/warehouse.js:118`) is generic
across SFCC `product-tile` grids; `toWarehouseObservation`
(`src/adapters/warehouse.js:181`) pins `retailer: "warehouse"`. The public type
contract is `src/adapters/warehouse.d.ts`.

## 1. Overview + entry commands

- `npm run warehouse` → `scripts/warehouse.js`. Subcommands: `store`, `deals`,
  `search <query>`, `feed`, `archive`, `track`
  (`scripts/warehouse.js:42-52`). `--pages all` (default for `archive`/`feed`)
  means unlimited pages; `--size` caps the page size (default 32). The client
  is constructed with no overrides (`scripts/warehouse.js:26`) — there are no
  env/origin overrides for this retailer; the catalogue is scoped nationally
  ("The Warehouse Online"), and the site's North/South selector does not
  identify store-specific prices (`scripts/warehouse.js:49-52`).
- `node scripts/warehouse-breadth.js` — walks one `cgid` by offset stepping.
  Flags: `--cgid`, `--file`, `--delay-ms` (default 3000), `--budget`
  (default 400), `--min-expected-products` (default 500), `--resume`,
  `--force-live` (`scripts/warehouse-breadth.js:54-117`).

Env: `ARCHIVE_FILE` names the live archive that breadth refuses to write to
(`scripts/warehouse-breadth.js:41`); no other env input exists. Never place
secrets in this lane — it needs none.

## 2. Endpoints

`{origin}` defaults to `https://www.thewarehouse.co.nz`
(`src/adapters/warehouse.js:5`).

| Purpose | Method | URL | Params |
|---|---|---|---|
| Deals grid (discounted products) | GET | `{origin}/search/updategrid` | `cgid` (default `foodhouseholdpets-fooddrink`), `pmid=twl-discountedProducts`, `start` (0-based offset), `sz` (default 32) — `listDeals`, `src/adapters/warehouse.js:278-286` |
| Search grid | GET | `{origin}/search/updategrid` | `q` (required, trimmed), `start` (0-based), `sz` — `searchProducts`, `src/adapters/warehouse.js:288-296` |
| Breadth grid walk | GET | `{origin}/search/updategrid` | `cgid`, `start` (stepped by 32), `sz=32` (`gridUrl`, `src/adapters/warehouse-breadth.js:212-219`) |

`cgid` values are SFCC category ids; the breadth default is the grocery tree
`foodhouseholdpets-fooddrink` (`scripts/warehouse-breadth.js:24`).

## 3. Auth & headers

- No auth. No cookies or tokens are sent.
- Headers on every grid request (`src/adapters/warehouse.js:226-231`):
  `accept: text/html,application/xhtml+xml`, `referer:
  https://www.thewarehouse.co.nz/c/food-pets-household/food-drink`, and a
  desktop Chrome `user-agent` (`src/adapters/warehouse.js:7-8`) — a browser
  fingerprint, because the endpoint sits behind bot protection.
- On the curl transport the user-agent is passed as `--user-agent` (not a
  `--header`), by filtering it out of the header list
  (`src/adapters/warehouse.js:250-252`); breadth repeats the same pattern
  (`src/adapters/warehouse-breadth.js:73-77`).

## 4. Request params

- `cgid`: category id string. Breadth guards it as a plain argv element —
  hostile strings cannot leave the argv array (repo rule: execFile arrays,
  never shell strings).
- `start`: 0-based tile offset; page N ⇒ `start = (N-1) * size`
  (`src/adapters/warehouse.js:283,293`). The server caps a page at 32 tiles
  (`TILE_STEP`, `src/adapters/warehouse-breadth.js:208`).
- `sz` / `size`: page size, default 32.
- `pmid=twl-discountedProducts`: selects the discounted-products merchandising
  slot (deals only).
- `q`: free-text query; blank queries throw `TypeError`
  (`src/adapters/warehouse.js:289`).
- `includeMarketplace` (collect options): marketplace tiles are excluded by
  default (`src/adapters/warehouse.js:302`, `:311`).

## 5. Response shape (consumed fields only)

HTML grid fragment. `parseWarehouseProducts`
(`src/adapters/warehouse.js:96-112`) walks
`<div class="product-tile" data-gtm-product="{JSON}">` tiles:

| Field | Type | Use |
|---|---|---|
| `data-gtm-product` JSON | object per tile | `JSON.parse` of the HTML-entity-decoded attribute; malformed JSON skips only that tile |
| `id` | string | product identity; required |
| `name` | string | required |
| `price` | number (dollars) | → `promoCents`/`regularCents` via `cents()` |
| `productThenPrice` | number or null | "was" price |
| `productEAN` | string | GTIN when not `"na"` |
| `brand` | string | when not `"na"` |
| `category` | string | `/`-split into `product.categories` |
| `promotionCallOutMessage` | string | `"N for $X"` → MULTIBUY (`multibuy`, `src/adapters/warehouse.js:83-93`); otherwise promotion description |
| `marketplaceProduct` | boolean | excluded unless `includeMarketplace` |
| `path` (from tile `<a href … embed-responsive>`) | string | → `source.url` (`new URL(path \|\| /p/{id}.html, origin)`, `src/adapters/warehouse.js:176`) |
| `image` (from `tile-image`) | string | → `product.images.primary` |

Grid envelope: the "1 – N of M products" header yields the total item count
(`totalItems`, `src/adapters/warehouse.js:73-77`; exported as
`totalGridItems`, `:79-81`). `toSfccObservation`
(`src/adapters/warehouse.js:118-179`) returns `undefined` when `id`, `name`,
or a finite price is missing — unpriced tiles are not errors.

## 6. Pagination / enumeration

- Deals/search client: do/while over page 1..n; pages derived from
  `ceil(totalItems / size)` read per page (`#collect`,
  `src/adapters/warehouse.js:298-316`), capped by `maxPages`; products dedupe
  by id.
- Breadth walker (`crawlCgid`, `src/adapters/warehouse-breadth.js:167-500`):
  steps `start` by 32 until a 0-tile page, with:
  - resume via a checkpoint manifest keyed `{cgid}:off{start}`
    (`taskId`, `:221-223`);
  - a hard ceiling of 200 windows (`DEFAULT_MAX_WINDOWS`, `:38,190`);
  - fingerprint drift detection — a repeated sorted-product-id hash stops the
    walk as unhealthy (`fingerprintProductIds`, `:132-135`);
  - mark-AFTER-record checkpointing: archive first, manifest second
    (`scripts/warehouse-breadth.js:174-186`).
  - Unlike FreshChoice breadth, the script re-crawls from scratch by default;
    `--resume` opts into skipping recorded windows
    (`scripts/warehouse-breadth.js:142-149`).

## 7. Timeouts / retries / rate limiting

- Client, curl transport: curl `--max-time 30` caps the transfer
  (`src/adapters/warehouse.js:263-264`) plus a process-level execFile
  `timeout` of 45 000 ms as a backstop (`CURL_EXEC_TIMEOUT_MS`, `:12,270`);
  `maxBuffer` caps the captured body at 20 MiB (`:270`). Response bodies on
  the fetch transport go through `readBodyText` with the same 20 MiB cap
  (`src/adapters/warehouse.js:244`; cap `src/adapters/fetch-with-retry.js:10`).
- Client, fetch transport: `fetchWithRetry` from
  `src/adapters/fetch-with-retry.js` with per-attempt timeout (default
  15 000 ms, `src/adapters/warehouse.js:239`); retry policy (GET,
  429/502/503/504 + retryable network errors, backoff, `Retry-After`) lives in
  that shared module (`:88-120,171`).
- Breadth transport: identical curl flags plus `--write-out '\n%{http_code}'`
  to recover the status line (`src/adapters/warehouse-breadth.js:89-95`),
  20 MiB `maxBuffer` and the 45 000 ms execFile timeout (`:95`). Retries are
  the walker's job: each failed offset is retried in place, and a circuit
  breaker opens after 5 consecutive failures of any kind (transport errors
  `:296-301`, HTTP errors `:325-330`, non-grid bodies `:351-356`, empty first
  pages `:377-382`).
- Rate limiting: `crawlCgid` enforces a 3 000 ms pacing floor unless
  `unsafeFastPacing` is set, because The Warehouse aggressively blocks faster
  clients (`MIN_DELAY_MS`, `src/adapters/warehouse-breadth.js:35,194-201`);
  the request budget is decremented before every transport call, including
  failures (`:240-248,276-277`). Script default `--delay-ms` is 3000
  (`scripts/warehouse-breadth.js:26`).

### curl/execFile transport (why and how)

- **Why curl:** the endpoint's bot protection fingerprints TLS; Node's `fetch`
  handshake gets blocked while curl's is accepted. This is a repo rule: the
  adapter must keep using `curl` via `execFile`, and **always array-form argv,
  never shell strings** (`src/adapters/warehouse.js:255-270`,
  `src/adapters/warehouse-breadth.js:78-96`).
- **argv construction** (client, `src/adapters/warehouse.js:257-269`):
  `["--silent","--show-error","--fail-with-body","--location","--compressed",
  "--max-time","30","--user-agent",<ua>, ...["--header","name: value"]…,
  <url>]` — each flag and value is its own array element; the URL is the final
  element. Breadth adds `"--write-out","\n%{http_code}"`
  (`src/adapters/warehouse-breadth.js:82-94`).
- **Output handling:** the client returns stdout verbatim (grid HTML). Breadth
  splits the LAST line off stdout as the HTTP status and treats the rest as
  the body (`src/adapters/warehouse-breadth.js:102-107`); an unparseable
  status becomes `0`, which the walker classifies as a transport failure.
  No temp files are used — everything flows through stdout.
- **Error paths:** a rejected execFile (curl non-zero exit, DNS failure,
  ENOENT, timeout kill) is rethrown through `summarizeCurlError`
  (`src/adapters/warehouse.js:23-36`), which bounds stderr/stdout quoting to
  400 chars and appends the exit code/signal — a blocked transfer cannot flood
  logs or warnings (`src/adapters/warehouse.js:272-274`,
  `src/adapters/warehouse-breadth.js:97-100`). `--fail-with-body` makes curl
  exit non-zero on HTTP ≥ 400 while still printing the body, so the client
  surfaces a real error; the breadth walker instead reads the `--write-out`
  status and applies its 403-fatal / error-breaker policy
  (`src/adapters/warehouse-breadth.js:312-330`).

## 8. Failure modes

- Non-2xx on the fetch transport: `assertOk` throws `The Warehouse {operation}
  failed: {status} {statusText}` (`src/adapters/warehouse.js:39-45`); on curl,
  the bounded `summarizeCurlError` message (§7).
- Challenge/error pages served with HTTP 200: the breadth walker refuses to
  accept them — Cloudflare markers (`NON_GRID_PATTERNS`, `:44-49`) or non-HTML
  bodies count as failures (`looksLikeGridBody`, `:119-127`), and a 0-tile
  first page is treated as a suspected block, not a catalogue end (`:365-382`).
- 403 is fatal immediately: the IP/client is blocked, so the walk aborts
  (`:312-318`).
- Malformed tile JSON: only that tile is skipped
  (`src/adapters/warehouse.js:100-104`); out-of-range HTML entities are kept
  verbatim instead of throwing `RangeError` (`decodeCodePoint`, `:49-54`).
- Unpriced/unnamed tiles: `toSfccObservation` returns `undefined` and callers
  filter them out.
- Offset drift / catalogue wrap: repeated window fingerprints stop the walk as
  `unhealthyTermination` (`:474`), which fails the run's health gate
  (`scripts/warehouse-breadth.js:223-229`).

## 9. Pointers

- Adapters: `src/adapters/warehouse.js`, `src/adapters/warehouse-breadth.js`;
  contract `src/adapters/warehouse.d.ts`.
- Shared transport: `src/adapters/fetch-with-retry.js` (`fetchWithRetry`,
  `readBodyText`).
- Tests: `test/adapters/warehouse.test.js` (parsers, observation mapping,
  entity hardening, curl argv/timeout caps, bounded curl errors),
  `test/warehouse-breadth.test.js` (crawlCgid walks, breaker paths, drift,
  budget, resume, runCollection).
- Scripts: `scripts/warehouse.js`, `scripts/warehouse-breadth.js`; helpers
  `scripts/lib/crawler.js` (manifest load/save).
- Related: `docs/apis/foodstuffs.md`, `docs/apis/freshchoice.md` (same doc
  set); nightly lane via `npm run breadth:nightly`
  (`docs/agent/command-map.md`).
