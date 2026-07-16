# Project Map — `nz-grocery-prices`

Read this for repo structure and ownership. Pair with `command-map.md` and
`verification.md`. Updated when structure changes (see `maintenance.md`).

## Shape

Zero-dependency ESM Node (`"type": "module"`, `engines.node >= 20`). Two data
layers: an append-only **JSONL archive** (authoritative) and a **SQLite
projection** (rebuildable, read-only) built with built-in `node:sqlite`
(**Node 26.3.1+ required** for the app server / SQLite paths; Node 20+ for
collectors and the legacy dashboard).

## Ownership boundaries

| Layer | Owns | Where | Rule |
|---|---|---|---|
| **adapters** | retailer API → `PriceObservation` | `src/adapters/` | pure transforms + injectable `fetch`. Warehouse uses `curl` via `execFile` (anti-bot), never shell strings. |
| **archive / repository** | JSONL persistence (authoritative) | `src/archive.js`, `src/repository.js` | the source of truth. Collectors append; everything else reads. |
| **analytics** | runtime deal computation | `src/analytics.js` | `/api/deals` calls this per-request. Not pre-materialized. |
| **SQLite projection** | rebuildable read-only price DB | `src/sqlite/projection-repository.js`, `schema.js`, `migrations/projection/` | **must never open `app.db`**. No user data. Destroy + rebuild freely. |
| **SQLite app DB** | persistent user data | `src/sqlite/app-db.js`, `migrations/app/` | users, sessions, watch list, preferred stores, saved searches, `product_match_pairs`. **Never rebuilt.** Back up. |
| **matching** | cross-retailer product matching | `src/matching/` | reads projection products → writes `product_match_pairs` into **app.db**. Fuzzy = candidates only, never confirmed. |
| **server** | HTTP routing | `src/server/server.js`, `handlers/public.js`, `handlers/private.js` | framework-free `node:http`. Dependencies passed by closure, not globals. |
| **app** | auth + startup composition | `src/app/auth.js`, `src/app/server.js` | the **only** place that opens both DBs. Owns startup order. |
| **SPA frontend** | browser UI | `public/` | no framework, no build step. Served by `src/app/server.js`. |
| **legacy dashboard** | deprecated JSONL-direct server | `dashboard/` | preserved fallback. Do **not** target for new work. |
| **collectors / scripts** | CLI entry points | `scripts/` | collection, `build-db`, `matching-cli`, `compact`, HAR capture. |

## Key directories

```
src/adapters/          retailer API clients + pure transforms
src/archive.js         PriceArchive (agentFeed, history, sales)
src/repository.js      JsonlObservationRepository (v2 record ↔ observation)
src/analytics.js       calculateSales / calculateOngoingSales / toAgentFeed
src/sqlite/            projection + app DB, migration runner
  migrations/projection/   001_initial.sql (LIKE + NOCASE, NO FTS5)
  migrations/app/          001_app_auth.sql, 002_product_matching.sql
src/matching/          orchestrator, matcher, fuzz, normalize
src/server/            Server class + public/private handlers
src/app/               auth (async scrypt) + server startup
public/                SPA (index.html, app.js, api.js, views/, components/, utils/)
dashboard/             deprecated legacy server
scripts/               collectors + build-db + matching-cli + archive runner
test/                  mirrors src/ structure (see verification.md)
data/                  gitignored: prices.jsonl, prices.db, app.db, collection-health.jsonl
```

## Two-DB boundary (load-bearing)

`data/prices.db` (projection) and `data/app.db` (user data) are **separate
files opened by separate classes**. A rebuild script that opens `app.db` is a
critical bug. Matching writes to `app.db.product_match_pairs`; the projection
DB's `product_matches` and `deal_signals` tables are **dead artifacts** — do
not read or write them. See `DECISIONLOG.md`.

## Domain terms

See `CONTEXT.md` for the ubiquitous language (Product / Store / Offer / Special
snapshot / Observation).
