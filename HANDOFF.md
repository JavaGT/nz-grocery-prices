# Grocery prices — implementation handoff

## Product shape (2026-07-17)

**One product in one repo.** Live Workbench UI/backend lives in **`site/`**.
Collectors + archive live here too. The experimental SQLite “lab” app was
**deleted** (no separate 3010 app).

| Role | Location | Port / URL |
|---|---|---|
| **Live product** | `site/` | **7070** → prices.javagrant.ac.nz |
| **Collectors + library** | `src/adapters`, `archive.js`, `repository.js`, `sqlite/`, `scripts/` | CLI |

### Where do I change X?

| Want to change… | Edit |
|---|---|
| Live UI | `site/public/index.html` |
| Live API | `site/server.mjs` |
| Retailer fetch | `src/adapters/` |
| Deal math | `src/analytics.js`, `src/archive.js` |
| Collectors | `scripts/` |

### Data for the live site

| File | Role |
|---|---|
| **`data/archive.db`** | Full multi-store archive (**preferred** live source) |
| `data/prices.jsonl` | Legacy / backup; smaller single-store-era snapshot |
| `site/grocery-prices.db` | Workbench users/sessions (not prices) |

`site/server.mjs` defaults to `archive.db` if present, else JSONL.
`PRICE_ARCHIVE_FILE` can override. launchd should point at `archive.db`.

Approx sizes (this machine, 2026-07-17): archive ~65k offer revisions, **61
stores** (57 Pak'nSave + others); old JSONL ~18k lines / ~5 stores.

### Run / deploy

```sh
ln -sfn /Users/server/Code/workbench node_modules/workbench
npm start
```

launchd: `ops/ai.acnz.prices.plist.template` →
`/Library/LaunchDaemons/ai.acnz.prices.plist`.

## Current objective

Keep collection healthy into **`data/archive.db`**; live site reads it.
GitHub Actions collection removed.

## Authoritative archive: Option 4

Default archive is **`data/archive.db`**. Migrate once from JSONL:

```sh
npm run migrate-archive
npm run build-db -- --force   # optional projection tooling
```

Daily: `npm run archive:local` (writes archive per runner config).

## Lab removal (2026-07-17)

Deleted: `src/app/`, `src/server/`, top-level `public/`, `src/matching/`,
`src/sqlite/app-db.js`, app migrations, lab tests, `data/app.db`,
`scripts/matching-cli.js`. Features that only lived there (lab auth, match UI,
saved-search API) are gone unless re-built into `site/` later.
