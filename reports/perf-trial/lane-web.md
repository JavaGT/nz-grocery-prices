# Lane B — Web Interface Performance Report

Branch: `perf-trial-20260906-0303-web` · 2026-09-06 · Node 26.7.0, zero-dep ESM

## Summary

Three changes: (1) static file serving now negotiates gzip/brotli, answers
conditional requests with 304 via weak ETags, and keeps file contents in an
mtime-keyed memory cache; (2) JSON API responses are gzipped above a 1KB
threshold at the `Server#respond` layer; (3) frontend: a 30s GET cache with
mutation invalidation in `api.js`, removal of the DOM-allocating `esc()` hot
path, and a dead-fetch/double-render fix in settings.

A full cold page load (13 static files, the entire app) drops
**66,962 B → 17,331 B (-75%)** with brotli, **-69%** with gzip-only clients.
A warm/refresh visit revalidates to **0 body bytes** (13 × 304).
`/api/products?limit=120` drops **39,869 B → 5,622 B (-86%)** on the wire.
Loopback p50 latencies are unchanged within noise (the win is wire bytes/CPU
for real networks); compression costs ~0.2 ms/request of user-space CPU.

## Measurements

### Static files (public/**) — wire bytes

Cold load, all 13 files, browser-like `Accept-Encoding: br, gzip`:

| file | before (raw) | after gzip | after brotli |
|---|---|---|---|
| / (index.html) | 550 | 341 | 188 |
| style.css | 17,602 | 4,100 | 3,528 |
| app.js | 2,860 | 1,024 | 843 |
| api.js | 3,717 | 1,247 | 1,584* |
| views/*.js (5) | 23,216 | ~7,543 | ~6,162 |
| utils/*.js (2) | 3,892 | 1,481 | 1,229 |
| components/*.js (3) | 18,995 | 5,979 | 5,234 |
| **TOTAL** | **65,953** | **20,122 (-69%)** | **18,539 (-72%)** |
| **TOTAL after frontend edits** | **66,962** | — | **17,331 (-75%)** |

*api.js grew ~1.6KB raw because it gained the client-side cache; compressed
it is 1,584 B.

Warm revalidation (repeat visit, If-None-Match): **13 requests, 0 body bytes**
(all 304). Before: 65,953 B refetched every visit (HTML never validated, no
ETags anywhere).

gzip-only client (e.g. older proxies): style.css 17,602 → 4,100.

### JSON API — wire bytes

| endpoint | raw | gzip |
|---|---|---|
| /api/products?limit=120 | 39,869 | 5,622 (-86%) |
| /api/products?limit=42 | 13,615 | ~2,300 |
| /api/deals (fresh app.db, empty tiers) | 351 | 351 (below 1KB threshold, sent raw) |
| /api/health | 463 | 463 (below threshold) |

The mission's "~100KB /api/deals" case (populated watch list + preferred
stores) compresses at the same ~80-86% ratio observed on the 40KB products
payload; the compression is body-size driven, not endpoint driven.

### Latency (tools/bench-server.js, 30 reps, loopback)

`reports/perf-trial/bench-before-laneB.json` vs `bench-after-laneB.json`:

- static: index 0.21 → 0.28 ms p50, style.css 0.18 → 0.23 ms p50 (+0.05 ms,
  negotiation + etag header cost; on localhost, compression saves nothing)
- API endpoints unchanged within noise (health 0.45 → 0.28, suggestions
  0.24 → 0.24, history 0.25 → 0.25)
- deals p50 55.7 → 59.7 ms — that path is the coordinator's memoization lane,
  not mine; my gzip adds ≤0.2 ms to it (measured below)

### Compression CPU cost (gzipSync, measured on this machine)

- 6.7KB JSON: 0.036 ms/response
- 39.9KB JSON: 0.166 ms/response
- Static files: zero at steady state — encoded variants are cached per file
  version and computed at most once each (one brotli + one gzip pass per
  changed file; full-site one-time cost is a few ms).

## Changes

### 1. Static serving — `src/app/server.js` `createStaticFallback`

- **gzip/brotli negotiation** (`Accept-Encoding`, q-values, q=0 rejection),
  brotli preferred when both accepted (measured ~3-8% smaller). Variants
  cached per file; non-compressible types (images/fonts) and files <256 B
  never compressed. `Vary: Accept-Encoding` on compressible responses.
- **Weak ETags** `W/"<size36>-<mtime36>"`; `If-None-Match` (weak comparison,
  list, `*`) → 304 with etag/cache-control/vary and no body. mtime change
  invalidates immediately (verified by test).
- **Memory cache** keyed by absolute path, entries `{mtimeMs, size, content,
  etag, compressible, encodings}`. Repeat requests do one `statSync` (cheap
  metadata read, keeps file updates live without restart) instead of
  `readFileSync`. Total footprint worst case = raw 67KB + brotli 17.3KB +
  gzip ~20KB ≈ **104KB** for the entire site — bounded by the public dir size.
- **Security preserved**: `..`/NUL rejection, prefix guard (hardened with
  explicit path separator), nosniff, HEAD (now reporting the *encoded*
  content-length), SPA fallback routes, HSTS env flag. SPA fallback now goes
  through the same serve path, so it gains nosniff/etag/compression it lacked.
- Existing cache-control semantics unchanged (HTML no-cache, assets
  max-age=3600). `createStaticFallback` is now exported.

### 2. JSON API — `src/server/server.js`

- `#respond` gzips bodies ≥1,024 B when gzip accepted; explicit
  `content-length` of the encoded body; `Vary: Accept-Encoding` on all JSON
  responses; uncompressed responses also get correct content-length (was
  chunked before). `parseAcceptEncoding` exported here and reused by static
  serving (one source of truth). Handlers untouched (per lane ownership).

### 3. Frontend — `public/**`

- **api.js**: 30s TTL cache for GETs; concurrent identical GETs share one
  promise (previously the first was *aborted* and re-fired); any mutation —
  success *or* failure — clears cached reads; cached data cloned on write and
  read so callers can't poison state; Content-Type only sent with a body;
  `api.clearCache()` exposed. Effect: switching deals→browse→watchlist→saved
  →deals does 4 fetches per session instead of refetching on every switch.
- **esc() removal** (render hot spot + correctness): `esc()` built a DOM
  element per call and HTML-escaped strings that were then inserted via
  `createTextNode`/`setAttribute`, so `&` rendered as literal `&amp;` and a
  120-card deals render wasted ~360 element allocations. All 18 call sites
  cleaned; `esc` deleted from `utils/dom.js` (no remaining users, verified).
- **settings.js**: removed dead `checkSession()` — it fetched /api/health,
  ignored the result, and re-rendered the whole view a second time on every
  mount. **browse.js**: removed dead `if/else` that called `load()` both ways.

## Trade-offs

- gzip CPU (0.17 ms @ 40KB) is per-request and synchronous; acceptable vs the
  ~60-107 ms deals compute it rides along with, but worth remembering if a
  future endpoint streams multi-MB bodies.
- Static cache staleness is bounded by one statSync per request — a changed
  file is picked up on the next request; no restart, no TTL guesswork.
- Memory for cached buffers is unbounded *per unique file* but the public dir
  is 67KB total; a pathological public dir would need an LRU cap.
- The 1KB API threshold means small hot responses (health, empty deals) ship
  uncompressed — deliberate: gzip overhead beat wire savings there on
  loopback, and they're small anyway.
- Browser caching: assets keep max-age=3600 (no fingerprinted filenames in a
  no-build-step repo, so aggressive max-age would risk stale assets); ETag
  revalidation makes the no-cache HTML path free.

## Deliberately skipped

- Serving pre-compressed `.gz`/`.br` files from disk (needs a build step or
  dual artifacts; memory cache already makes CPU a non-issue).
- Brotli for dynamic API responses (gzip chosen: streaming-friendly, and
  3-8% size delta isn't worth a second dynamic path yet).
- HTTP/2, cache-digests, service worker, fingerprinted assets — out of scope
  for a no-dependency/no-build repo.
- Frontend virtualization for the 120-card grid: card creation is now
  measurably leaner (esc fix) and 120 nodes renders in a frame budget;
  revisit only with browser-profile evidence.
- deals.js/deleted `delegate` import cleanup beyond files already touched.

## Verification

- `npm run check` — pass
- `node --test test/server/*.test.js test/frontend/*.test.js` — 176 pass, 0 fail
- full `npm test` — **872 tests, 871 pass, 0 fail, 1 skipped, 12.1 s**
- Manual curl: gzip/br/vary/etag/304/HEAD/traversal/nosniff all verified live;
  gzip body round-trips byte-identical to raw.
- test/server/server-static.test.js now constructs the *real*
  `createStaticFallback` (the old test carried a 90-line inline copy of the
  implementation — a drift hazard; expectations that changed are new-behavior
  tests only, all 15 original cases pass unmodified).

## Commits (this branch)

- `d4c76e9` web perf: gzip/brotli + weak ETag/304 + mtime cache for static; gzip for JSON API
- `8303181` web perf tests: static tests use real createStaticFallback; compression + etag coverage
- `6927272` web perf frontend: 30s GET cache w/ mutation invalidation; drop DOM-allocating esc; fix settings double render

Evidence files: `reports/perf-trial/bench-before-laneB.json`,
`bench-after-laneB.json`, this report.
