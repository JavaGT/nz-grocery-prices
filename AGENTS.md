# Agent Instructions — `nz-grocery-prices`

One repo: **collectors + live Workbench product**.

ESM Node. Live site needs `workbench` via `node_modules/workbench` →
`/Users/server/Code/workbench`. `node:test`. Node 20+ collectors; Node 26.3.1+
for SQLite archive paths.

## Ownership (read this first)

| Piece | Role | Path |
|---|---|---|
| **Live product** | UI + Workbench API | **`site/`** |
| **Live URL** | https://prices.javagrant.ac.nz | nginx → **7070**, launchd `ai.acnz.prices` |
| **Collectors / library** | Adapters, archive, analytics | `src/adapters/`, `src/archive.js`, `src/repository.js`, `src/sqlite/`, `scripts/` |

There is **no lab app**. Deleted 2026-07-17 (`src/app/`, `src/server/`, top-level
`public/`, matching, lab auth). Do not recreate without an explicit product ask.

**Live price data:** `data/archive.db` (preferred) or `data/prices.jsonl`.
`site/server.mjs` uses `createObservationRepository` (`.db` → SQLite).

## Start here

1. This file.
2. `docs/agent/project-map.md`
3. `docs/agent/command-map.md`
4. `docs/agent/verification.md`
5. `HANDOFF.md`
6. `DECISIONLOG.md`
7. `site/README.md`

## Default workflow

1. Surface: live `site/` or collectors/archive.
2. Inspect adjacent tests; smallest change in owning layer.
3. `npm run check`, targeted tests, `npm test` / `npm run test:site`.
4. Restart live: launchd `ai.acnz.prices` (or process on 7070). No hot reload.
5. Update `docs/agent/*` when structure/commands change.

## Live site

```sh
mkdir -p node_modules && ln -sfn /Users/server/Code/workbench node_modules/workbench
npm start   # site/server.mjs — default PORT 7070
```

Edit: `site/server.mjs`, `site/public/index.html`.  
Shared: `src/archive.js`, `src/archive-factory.js`, adapters.

launchd: `ops/ai.acnz.prices.plist.template` (WorkingDirectory = this repo).

## Hard rules

- **Collectors are not tests.** `npm run archive:local` / `npm run <retailer>` hit live APIs.
- **`collector.env` gitignored** (may hold `WOOLWORTHS_COOKIE`). Never commit.
- **Warehouse:** `curl` via `execFile`, never shell strings.
- **Live user DB:** `site/grocery-prices.db` (Workbench). Not price archive.
- **Archive SQLite** (`data/archive.db`) is the multi-store collection path;
  keep JSONL as backup until dual-write is routine.
- **Projection `data/prices.db`** is rebuildable tooling (`npm run build-db`);
  live site does **not** require it (reads archive via `PriceArchive`).
- Dead projection tables `deal_signals` / `product_matches` — ignore.

## Handoff requirements

Changed files, behavior, verification, risks, docs updated or why not.
