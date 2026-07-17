# Live product — NZ Grocery Prices

This is the **public site** served at https://prices.javagrant.ac.nz.

Workbench UI + Workbench auth backend, co-located with collectors in the
`prices` repo. The Workbench *framework* still lives at
`/Users/server/Code/workbench` (linked via `node_modules/workbench`).

## Run locally

From the prices repo root (so `node_modules/workbench` resolves):

```sh
# ensure framework link exists
ln -sfn /Users/server/Code/workbench node_modules/workbench

PORT=7070 npm start
# defaults to data/archive.db when present; override with PRICE_ARCHIVE_FILE
# or: node site/server.mjs
```

## Production

launchd `ai.acnz.prices` → `node site/server.mjs` with:

| Env | Value |
|---|---|
| `PORT` | `7070` |
| `PRICE_ARCHIVE_FILE` | `/Users/server/Code/prices/data/archive.db` |
| WorkingDirectory | `/Users/server/Code/prices` |

nginx proxies the public hostname to `127.0.0.1:7070`.

## Layout

| Path | Role |
|---|---|
| `site/server.mjs` | Workbench app + `/api/*` public routes |
| `site/public/index.html` | Live UI (Deals / Browse / Favorites / Stats) |
| `site/grocery-prices.db` | Workbench user/session DB (gitignored) |
| `site/test/` | Site contract tests |

Shared price code: `../src/archive.js`, `../src/repository.js`, adapters.

## Not this folder

| Path | Role |
|---|---|
| `dashboard/` | Deprecated local JSONL UI |
| Collectors | `scripts/`, `src/adapters/` |
