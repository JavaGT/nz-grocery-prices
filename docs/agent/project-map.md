# Project Map — `nz-grocery-prices`

Read this for repo structure and ownership. Pair with `command-map.md` and
`verification.md`. Updated when structure changes (see `maintenance.md`).

## Shape

ESM Node (`"type": "module"`, `engines.node >= 20`). Authoritative **archive**
(`data/archive.db`, or legacy `data/prices.jsonl`), optional rebuildable
**projection** (`data/prices.db` for tooling). Live product is Workbench in
`site/`. Built-in `node:sqlite` (**Node 26.3.1+**) for SQLite archive paths.

## Ownership boundaries

| Layer | Owns | Where | Rule |
|---|---|---|---|
| **adapters** | retailer API → `PriceObservation` | `src/adapters/` | pure transforms + injectable `fetch`. Warehouse uses `curl` via `execFile` (anti-bot), never shell strings. |
| **archive / repository** | authoritative collection history | `src/archive.js`, `src/repository.js` (JSONL), `src/sqlite/archive-repository.js` + `src/archive-factory.js` (SQLite) | source of truth. Path extension selects backend (`.db` → SQLite). Collectors append; everything else reads. Never opens `app.db`. |
| **analytics** | runtime deal computation | `src/analytics.js` | `/api/deals` calls this per-request. Not pre-materialized. |
| **SQLite projection** | optional rebuildable read DB | `src/sqlite/projection-repository.js`, `schema.js`, `migrations/projection/` | tooling via `build-db`. Live site reads archive via `PriceArchive`, not this DB. |
| **live site** | public UI + Workbench API | `site/server.mjs`, `site/public/` | **Product.** `npm start` / port **7070**. Workbench via `node_modules/workbench`. Archive: `archive.db` (preferred) or JSONL. User DB: `site/grocery-prices.db`. |
| **legacy dashboard** | deprecated JSONL-direct server | `dashboard/` | Do not target for new work; avoid port 7070. |
| **collectors / scripts** | CLI entry points | `scripts/` | collection, `build-db`, `migrate-archive`, `matching-cli`, `compact`, HAR capture. |

## Key directories

```
src/adapters/          retailer API clients + pure transforms
src/archive.js         PriceArchive (agentFeed, history, sales)
src/archive-factory.js createObservationRepository(.db → SQLite, else JSONL)
src/repository.js      JsonlObservationRepository (v2 record ↔ observation)
src/analytics.js       calculateSales / calculateOngoingSales / toAgentFeed
src/sqlite/            archive + optional projection, migration runner
  archive-repository.js    SqliteArchiveRepository (authoritative Option 4)
  migrations/archive/      001_initial.sql
  migrations/projection/   001_initial.sql
site/                  live Workbench product
dashboard/             deprecated legacy server
scripts/               collectors + build-db + migrate-archive + archive runner
test/                  collectors, archive, site tests
data/                  gitignored: archive.db, prices.jsonl, prices.db
```

## Data files

| File | Role | Rebuildable? |
|---|---|---|
| `data/archive.db` (or legacy `prices.jsonl`) | authoritative collection history | no (migrate JSONL once) |
| `data/prices.db` | optional projection tooling | yes — `npm run build-db` |
| `site/grocery-prices.db` | Workbench users/sessions | no (not price data) |

Live site reads the archive via `PriceArchive` + `createObservationRepository`.
Projection dead tables (`deal_signals`, `product_matches`) — ignore.

## Domain terms

See `CONTEXT.md` for the ubiquitous language (Product / Store / Offer / Special
snapshot / Observation).
