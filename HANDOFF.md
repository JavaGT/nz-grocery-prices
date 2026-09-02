# Grocery prices — implementation handoff

## Current objective

Run retailer price collection on this Mac and serve the completed archive to a hosted app. GitHub Actions collection has been intentionally removed.

## Implemented local collection path

- `scripts/archive-daily-local.sh` runs the five existing retailer archive commands.
- It copies the existing archive to a same-directory temporary file, directs every collector to it, validates its JSONL, then atomically replaces the live archive only after every command succeeds.
- It preserves the original archive and cleans up its temporary file on failure.
- It rejects overlapping runs with a mkdir-based lock.
- It supports `ARCHIVE_FILE`, `NPM_COMMAND`, `PAKNSAVE_STORE` (optional —
  unset = every PAK'nSAVE store via `--all-stores`), `PAKNSAVE_DELAY_MS`,
  `NEWWORLD_STORE`, and optional `COLLECTOR_ENV_FILE` environment variables.
- `package.json` provides `npm run archive:local`.
- `test/local-archive-runner.test.js` proves successful publication and failure preservation using a fake npm executable.
- `ops/nz.grocery-prices.archive.daemon.plist.template` is the correct headless macOS `LaunchDaemon` template. It runs as a specified local user at 4:00am and does not contain secrets.
- `README.md` documents local collection and daemon installation.

## Verification already completed

```sh
sh -n scripts/archive-daily-local.sh
node --test test/local-archive-runner.test.js
plutil -lint ops/nz.grocery-prices.archive.daemon.plist.template
git diff --check
```

All passed. Do **not** run `npm run archive:local` as a smoke test unless intentionally collecting live retailer data: it performs network collection and may change `data/prices.jsonl`.

## macOS account resolution (resolved 2026-07-17)

The Directory Services record for `server` / UID 501 was repaired (by the Mac
administrator). All previously-failing commands now succeed:

```text
id -P                 -> server:********:501:20::0:0:Server:/Users/server:/bin/zsh
dscacheutil -q user   -> resolves (uid 501, gid 20, shell /bin/zsh)
sudo -l               -> (ALL) NOPASSWD: ALL
launchctl managername -> Background
```

`/Users/server/Code/prices/collector.env` exists, is empty, and has mode 600. It
may later contain `KEY=value` settings such as `WOOLWORTHS_COOKIE`,
`FRESHCHOICE_ORIGIN`, and `FRESHCHOICE_STORE_NAME`. Never commit it or put secret
values in the plist.

## Multi-store collection (2026-07-17)

Daily archive collects **every store** where the retailer exposes a public
store list:

| Retailer | Mode | Count (approx) | Override env |
|---|---|---|---|
| PAK'nSAVE | all stores | ~57 | `PAKNSAVE_STORE` |
| New World | all stores | ~148 | `NEWWORLD_STORE` |
| FreshChoice | all storefronts | ~76 | `FRESHCHOICE_ORIGIN` or `FRESHCHOICE_STORE` |
| Woolworths | single fulfilment | 1 | `WOOLWORTHS_COOKIE` |
| Warehouse | national online | 1 | — |

One failed store does not abort the rest of that retailer's loop; the CLI
exits 0 if any store succeeded. Delays: `PAKNSAVE_DELAY_MS`,
`NEWWORLD_DELAY_MS`, `FRESHCHOICE_DELAY_MS` (default 1000 each).

**Woolworths** has no public multi-store price API (session/cookie picks one
fulfilment store). **Warehouse** prices are national, not per-store.

Expect the 4am run to take much longer than before (Foodstuffs + FreshChoice
across ~280 storefronts).

## Collection scheduling

The historical `nz.grocery-prices.archive` LaunchDaemon described in earlier
versions of this handoff is not installed on the current machine, and its old
`/Users/server/Code/prices` path no longer exists. The current breadth pilot is
the intended collection path. It runs PAK'nSAVE, New World, FreshChoice,
Warehouse, and Woolworths into separate `data/breadth-pilot-*.jsonl` archives.

The runner is `scripts/breadth-pilot-nightly.sh`, exposed as
`npm run breadth:nightly`. Install
`ops/nz.grocery-prices.breadth.daemon.plist.template` as a 3:30am LaunchDaemon
when scheduling is wanted. It deliberately does not write the app's
authoritative `data/prices.jsonl` archive.

## Broader product/app state

- Website first vertical slice: `/Users/server/Code/workbench/projects/grocery-prices` (**price•minder** redesign implemented).
- Public homepage: image-led "Best deals right now" from `/api/deals` (history-backed + advertised, explicit price context).
- Signed-in dashboard: deal ledger, watch list, preferred stores (Workbench session cookie).
- Visual source: `docs/designs/price-minder-refined-mockup.html`. Brief: workbench `projects/grocery-prices/IMPLEMENTATION-BRIEF.md`.
- It uses Workbench built-in username/password sessions and SQLite for private account data.
- Public product search/history currently reads JSONL directly; it does not yet use a SQLite price projection.
- Price contexts are explicit: Foodstuffs physical store, Woolworths pickup/fulfilment, FreshChoice store-site, Warehouse national online.
- `DECISIONLOG.md` and `docs/wayfinding-mvp.md` contain the product decisions. `docs/sqlite-website-design.md` is a future scale/read-performance design, not the current archive implementation.

## Repository hygiene

This handoff predates the CORE-6 dashboard deletion on 2026-08-24. The
repository is now clean with respect to the legacy dashboard; local scheduling
work is confined to the runner, daemon template, focused runner test, README,
and this handoff.

CORE-5 (2026-08-24) shrank the package root to exactly 8 exports:
`PriceArchive`, `JsonlObservationRepository`, `MemoryObservationRepository`,
`parseObservation`, `calculateSales`, `calculateOngoingSales`,
`buildPriceSeries`, `toAgentFeed`. Retailer clients moved to subpath exports
only (`nz-grocery-prices/foodstuffs` etc.); ArchiveIndex, record codecs,
locking, and repair helpers are internal. `src/index.d.ts` and the adapter
`.d.ts` files are hand-maintained contracts, gated by
`test/types-surface.test.js` (no TS compiler exists). README's "Library API"
section documents the new surface.

## Deferred unknowns (resolved 2026-07-17)

### FTS5 full-text search

The projection schema does **not** use SQLite FTS5. Search uses `LIKE` with a
`COLLATE NOCASE` index on `products.name` (see `src/sqlite/migrations/projection/001_initial.sql`
and the `listProducts`/`searchSuggestions` handlers). The spec mentioned a future
`002_fts_product_search.sql` migration, but it was never needed — `LIKE` + NOCASE
index performs adequately for the current product count (~9,000). FTS5 remains an
option if search latency becomes a problem at scale.

### SPA auth endpoint alignment

The SPA and server are fully aligned: all 20 API paths the SPA calls
(`/api/deals`, `/api/products`, `/api/auth/*`, `/api/watch-list`, `/api/preferred-stores`,
`/api/saved-searches`, `/api/new-products`) have matching server routes. The
historical Workbench paths (`/auth/me`, `/auth/login`, `/watch-list` without
`/api` prefix) were migrated during P4.4.

One conceptual gap: there is no `/api/auth/me` session-probe endpoint. The SPA
relies on 401-driven re-authentication — a 401 on any private endpoint dispatches
an `auth:required` event that routes the user to the settings view. If a
"restore session on page load" UX is wanted later, a `GET /api/auth/me` endpoint
would need to be added on both sides.

### Workbench user migration

The Workbench prototype at `/Users/server/Code/workbench/projects/grocery-prices/`
has a `User` table (Workbench schema, `password` column) but currently has
**zero users**. The prices app uses `crypto.scrypt` with a `saltHex:digestHex`
format that differs from Workbench's hash format. Since there are no users to
preserve, **re-registration** on the prices app is the expected path. If real
Workbench users existed, a one-shot migration script porting `User.username` and
`User.password` into the prices `app.db` `users` table would be required, but
the hash formats are incompatible without a compatibility shim.
