# Grocery prices — implementation handoff

## Current objective

Run retailer price collection on this Mac and serve the completed archive to a hosted app. GitHub Actions collection has been intentionally removed.

## Implemented local collection path

- `scripts/archive-daily-local.sh` runs the five existing retailer archive commands.
- It copies the existing archive to a same-directory temporary file, directs every collector to it, validates its JSONL, then atomically replaces the live archive only after every command succeeds.
- It preserves the original archive and cleans up its temporary file on failure.
- It rejects overlapping runs with a mkdir-based lock.
- It supports `ARCHIVE_FILE`, `NPM_COMMAND`, `PAKNSAVE_STORE`, `NEWWORLD_STORE`, and optional `COLLECTOR_ENV_FILE` environment variables.
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

## Current blocker: macOS account resolution

The active SSH shell is shown as `server`, UID 501, but macOS Directory Services cannot resolve that account. Observed results:

```text
id                    -> uid=501 gid=20(staff) ...
id -P                 -> id: getpwuid: Undefined error: 0
dscacheutil / dscl    -> Directory Services error
crontab -l            -> UID is not in the passwd file
launchctl managername -> Could not get manager name
sudo                  -> you do not exist in the passwd database
```

This is not a plist problem. It prevents scheduling with `sudo`, `launchd`, or `crontab` for this account. The earlier `~/Library/LaunchAgents` configuration was removed because it was also the wrong service type for an SSH/headless collector.

`/Users/server/Code/prices/collector.env` exists, is empty, and has mode 600. It may later contain `KEY=value` settings such as `WOOLWORTHS_COOKIE`, `FRESHCHOICE_ORIGIN`, and `FRESHCHOICE_STORE_NAME`. Never commit it or put secret values in the plist.

## Required external action

Ask the Mac administrator to repair the Directory Services record for `server` / UID 501, or provide a valid local administrator/collector account. The record is ready when these work for the intended collector account:

```sh
id -P
dscacheutil -q user -a name <collector-user>
sudo -l
launchctl managername
```

## Install after the account is fixed

Replace `<collector-user>` with a valid local account. The checkout at `/Users/server/Code/prices` must be readable to that user.

```sh
sudo cp /Users/server/Code/prices/ops/nz.grocery-prices.archive.daemon.plist.template /Library/LaunchDaemons/nz.grocery-prices.archive.plist
sudo sed -i '' -e 's|/REPLACE/WITH/ABSOLUTE/PATH|/Users/server/Code/prices|g' -e 's|REPLACE_WITH_COLLECTOR_USERNAME|<collector-user>|g' /Library/LaunchDaemons/nz.grocery-prices.archive.plist
sudo chown root:wheel /Library/LaunchDaemons/nz.grocery-prices.archive.plist
sudo chmod 644 /Library/LaunchDaemons/nz.grocery-prices.archive.plist
sudo plutil -lint /Library/LaunchDaemons/nz.grocery-prices.archive.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/nz.grocery-prices.archive.plist
sudo launchctl kickstart -k system/nz.grocery-prices.archive
```

The final `kickstart` intentionally performs a live collection. Review `/tmp/nz-grocery-prices-archive.log` and `/tmp/nz-grocery-prices-archive.error.log` afterwards.

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

Pre-existing dirty changes existed in `README.md`, `package.json`, `dashboard/`, and `test/` before this work. Preserve unrelated edits. Local scheduling work is confined to the runner, daemon template, focused runner test, README, and this handoff.

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
