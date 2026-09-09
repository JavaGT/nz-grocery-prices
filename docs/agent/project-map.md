# Project Map — `nz-grocery-prices`

Read this for repo structure and ownership. Pair with `command-map.md` and
`verification.md`. Updated when structure changes (see `maintenance.md`).

## Shape

Zero-dependency ESM Node (`"type": "module"`, `engines.node >= 20`). Two data
layers: an append-only **JSONL archive** (authoritative) and a **SQLite
projection** (rebuildable, read-only) built with built-in `node:sqlite`
(**Node 26.3.1+ required** for the app server / SQLite paths; Node 20+ for
collectors). The legacy dashboard was deleted (CORE-6); v1 archive records
are refused by all hot paths and handled only by
`scripts/migrate-v1-archive.js`.

## Ownership boundaries

| Layer | Owns | Where | Rule |
|---|---|---|---|
| **adapters** | retailer API → `PriceObservation` | `src/adapters/` | pure transforms + injectable `fetch`. Warehouse uses `curl` via `execFile` (anti-bot), never shell strings. |
| **archive / repository** | JSONL persistence (authoritative) | `src/archive.js`, `src/repository.js` | the source of truth. Collectors append; everything else reads. v2 records only — a v1 line throws with the migrator command. |
| **v1 migration** | one-shot legacy conversion | `scripts/migrate-v1-archive.js` | the ONLY v1 handler. Idempotent, backup-first, refuses `.db` paths and the live archive without `--force`. |
| **analytics** | deal computation rules | `src/analytics.js` | single source of deal logic. The rebuild materializes its output into the projection's `deal_signals` table (`src/sqlite/deal-materialization.js`); `/api/deals` serves those rows — no runtime analytics on the request path. |
| **SQLite projection** | rebuildable read-only price DB | `src/sqlite/projection-repository.js`, `schema.js`, `migrations/projection/` | **must never open `app.db`** (rebuild refuses app.db outputs). No user data. Destroy + rebuild freely. Fail-fast `<db>.lock`; refuses v1 archives. |
| **SQLite app DB** | persistent user data | `src/sqlite/app-db.js`, `migrations/app/` | users, sessions, watch list, preferred stores, saved searches, `product_match_pairs`. **Never rebuilt.** Back up. |
| **matching** | cross-retailer product matching | `src/matching/` | reads projection products → writes `product_match_pairs` into **app.db**. Fuzzy = candidates only, never confirmed. |
| **server** | HTTP routing | `src/server/server.js`, `handlers/public.js`, `handlers/private.js` | framework-free `node:http`. Dependencies passed by closure, not globals. |
| **app** | auth + startup composition | `src/app/auth.js`, `src/app/server.js` | the **only** place that opens both DBs. Owns startup order. |
| **SPA frontend** | browser UI | `public/` | no framework, no build step. Served by `src/app/server.js`. |
| **public surface** | root exports + type contract | `src/index.js`, `src/index.d.ts` | exactly 8 exports (PriceArchive, 2 repositories, parseObservation, 4 analytics). No adapters or internals at root; adapter `.d.ts` files are self-contained. Drift gate: `test/types-surface.test.js`. |
| **collectors / scripts** | CLI entry points | `scripts/` | collection, `build-db`, `matching-cli`, `compact`, `migrate-v1-archive`, HAR capture. |
| **retailers campaign** | 500-retailer scraper roster | `retailers/` | one subfolder per retailer (`index.js` + `collect.js` + `README.md`). Shared platform families in `retailers/_lib/` (shopify, magento/html-grid, sfcc-updategrid, estar-category, next-data, algolia, jsonld-pdp, http, observation, curl-transport, runner). Emits canonical PriceObservation; never touches `data/prices.jsonl` (runner enforces via `assertNotLiveArchive`). Roster + status: `retailers/README.md`. |

## Key directories

```
src/adapters/          retailer API clients + pure transforms
src/domain/            observation validation (parseObservation / validateObservation)
src/archive-records.js canonical v2 record encoding + content hashing (locale-pinned sort)
src/archive-index.js   in-memory archive index, planning, materialization, stats
src/repository.js      JsonlObservationRepository — lock, durable append, atomic compact, tail-tolerant load, v1 refusal
src/analytics.js       calculateSales / calculateOngoingSales / buildPriceSeries / toAgentFeed
src/sqlite/            projection + app DB, migration runner
  migrations/projection/   001_initial.sql (LIKE + NOCASE, NO FTS5)
  migrations/app/          001_app_auth.sql, 002_product_matching.sql
src/matching/          orchestrator, matcher, fuzz, normalize
src/server/            Server class + public/private handlers
src/app/               auth (async scrypt) + server startup
public/                SPA (index.html, app.js, api.js, views/, components/, utils/)
scripts/               collectors + build-db + matching-cli + migrate-v1-archive + archive runner
retailers/             500-retailer scraper campaign (README.md = manifest; _lib/ = shared families)
docs/apis/             upstream API docs for every scraper surface (index: docs/apis/README.md)
test/                  mirrors src/ structure (see verification.md)
data/                  gitignored: prices.jsonl, prices.db, app.db, collection-health.jsonl
```

## Two-DB boundary (load-bearing)

`data/prices.db` (projection) and `data/app.db` (user data) are **separate
files opened by separate classes**. A rebuild script that opens `app.db` is a
critical bug. Matching writes to `app.db.product_match_pairs`; the projection
DB's `product_matches` table is a **dead artifact** — do not read or write
it. `deal_signals` is a rebuild-populated cache of analytics output
(DECISIONLOG 2026-09-06, owner-approved; see
`src/sqlite/deal-materialization.js`); `/api/deals` serves those rows
directly via `defaultQueryDealSignals` (handler switch landed `e58303b`) —
no runtime analytics on the request path. See `DECISIONLOG.md`.

## Domain terms

See `CONTEXT.md` for the ubiquitous language (Product / Store / Offer / Special
snapshot / Observation).
