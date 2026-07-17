# nz-grocery-prices

A local-first New Zealand grocery price intelligence application. It collects supermarket prices over the long term, preserves a durable historical archive, and helps each user find meaningful savings on the products, categories, and searches they care about. The resulting data can also power meal planning, shopping lists, and other agent-assisted decisions.

The application is intended to support user accounts. Each user will be able to follow individual products, product categories, and saved search terms; mark favourite stores; and receive a focused view of relevant price changes and promotions. Store preferences should make it possible to prioritise nearby or preferred locations while still comparing the same item across retailers.

It currently has live collectors for the retailers in this priority order:

| Retailer | Price scope | Live support |
| --- | --- | --- |
| PAK'nSAVE | Selected physical store | Stores, search, specials, archive |
| Woolworths NZ | Selected fulfilment store | Specials, archive |
| New World | Selected physical store | Stores, search, specials, archive |
| SuperValue | Selected store website | Stores, search, specials, archive (~3 webshops) |
| FreshChoice | Selected store website | Search, specials, archive |
| The Warehouse | National online catalogue | Search, food/drink specials, archive |

Coverage is intended to include the major supermarket brands relevant to NZ grocery shopping: PAK'nSAVE, New World, Woolworths, SuperValue, FreshChoice, and The Warehouse's grocery catalogue. Each retailer may expose a different price scope—physical store, fulfilment store, store website, or national online catalogue—and the application must retain that scope rather than implying that all prices are directly interchangeable.

Prices are stored as integer NZ cents. Every observation records the retailer, price scope, product source ID, collection time, regular/promotion/member prices, and promotion metadata when available. The archive is designed to grow for years, allowing current prices to be judged against meaningful long-term baselines rather than only the most recent snapshot.

## Product direction

The central user outcome is:

> Find the groceries I care about at a price I can trust, in the stores I prefer, with enough history to know whether it is genuinely good value.

The application should let a user:

- create an account and keep their preferences across devices;
- follow specific products, categories, and search terms;
- choose favourite stores and prioritise those stores in results;
- compare offers for the same product across supported retailers and locations;
- inspect long-term price history, promotions, and all-time lows;
- receive relevant deal and price-drop information without monitoring every product manually.

This is a price-history and decision-support product, not an online checkout system. It is also not intended to claim complete nationwide coverage unless the underlying archive actually contains the relevant stores and observations.

## One repo layout

| | Live product | Collectors / library |
|---|---|---|
| What | https://prices.javagrant.ac.nz | Retailer scrape + archive |
| Code | **`site/`** | `src/adapters`, `scripts/`, `src/archive.js`, `src/sqlite/` |
| Command | `npm start` (port **7070**) | `npm run paknsave`, … |
| Data | **`data/archive.db`** (preferred) | collectors append here |

Live UI uses the **Workbench framework** (`node_modules/workbench` →
`/Users/server/Code/workbench`). See `site/README.md` and `HANDOFF.md`.

## Quick start

### Live site (product)

```sh
mkdir -p node_modules && ln -sfn /Users/server/Code/workbench node_modules/workbench
PORT=7070 npm start
```

### Collectors

```sh
npm run paknsave -- archive "Royal Oak"   # hits live APIs
npm run archive:local
```

Write into **`data/archive.db`**. Legacy `data/prices.jsonl` is backup only.

### Data lifecycle

- **`data/archive.db`:** Authoritative multi-store collection history. Live site
  reads this. Collectors append here. Migrate once from JSONL with
  `npm run migrate-archive`.
- **`data/prices.jsonl`:** Legacy backup only.
- **`data/prices.db`:** Optional projection tooling (`npm run build-db`). Not
  required for the live site.
- **`site/grocery-prices.db`:** Workbench users/sessions (not price data).

### Deals (runtime computation)

`GET /api/deals` computes deals at request time via `src/analytics.js`
(`calculateSales` / `calculateOngoingSales`) from the archive — no pre-built
deal table.

### Collector commands

Discover stores and inspect live results:

```sh
npm run paknsave -- deals "Royal Oak" --pages 1
npm run newworld -- search "Green Bay" butter --json
npm run woolworths -- deals --pages 1
npm run freshchoice -- search butter --pages 1
npm run supervalue -- search butter --pages 1
npm run warehouse -- deals --pages 1
```

Archive the complete advertised-specials snapshot for each retailer:

```sh
npm run paknsave -- archive "Royal Oak"
npm run newworld -- archive "Green Bay"
npm run woolworths -- archive
npm run freshchoice -- archive
npm run supervalue -- archive
npm run warehouse -- archive
```

The default archive is `data/archive.db` (normalized SQLite). It is change-only: a product revision is stored once by content hash, prices are product/store offers, and each daily archive records only a compact special-listing delta per store. An unchanged daily run therefore adds just one snapshot per collected store. Use `--file path/to/archive.db` (or a `.jsonl` path for the legacy format).

The normalized shape is designed for one product to have offers at every collected supermarket store:

| Archive record | Key | Contains |
| --- | --- | --- |
| Product revision | `productId` + SHA-256 hash | Name, brand, image, size, description, GTIN and other product metadata |
| Store revision | `storeId` + SHA-256 hash | Store identity and price scope |
| Offer revision | `productId` + `storeId` | Price, promotion and source data |
| Special snapshot | `scope` + `storeId` + time | Added/removed offer IDs proving what remains on special |

This keeps metadata and prices independently historical. Inspect all known versions of a product—including changed images and descriptions—with:

```sh
npm run prices -- product foodstuffs:5226969-ea-000
```

Run `npm run compact` to convert a legacy v1 archive or remove duplicate records after an interrupted/manual ingestion.

For products that are not currently advertised, track targeted searches regularly:

```sh
npm run paknsave -- track "Royal Oak" "Anchor butter"
npm run newworld -- track "Green Bay" "oat milk"
npm run freshchoice -- track "chicken breast"
npm run warehouse -- track coffee
```

## Sale intelligence and agent feed

Current advertised promotions work from the first snapshot:

```sh
npm run prices -- ongoing
npm run prices -- ongoing --retailer paknsave
```

The combined feed contains two deliberately separate lists:

- `ongoingSales`: current advertised promotions, with the regular price and advertised saving when known.
- `sales`: history-backed drops from the recent average, including strict new all-time lows.

```sh
npm run prices -- feed --drop 20 --baseline-days 90 --samples 4
```

Restrict either command to favourites by repeating `--product`, or keep IDs in a JSON file:

```json
{
  "productIds": [
    "foodstuffs:5226969-ea-000",
    "woolworths:272665"
  ]
}
```

```sh
npm run prices -- feed --favorites favourites.json --drop 15
npm run prices -- history foodstuffs:5226969-ea-000
npm run prices -- product foodstuffs:5226969-ea-000
npm run prices -- stats
```

Product IDs are printed by retailer `search` and `deals` commands. A history signal needs at least the configured number of earlier snapshots; until then, `sales` is correctly empty while `ongoingSales` remains useful.

For a simple local schedule, archive once each morning and generate a feed afterward. Keep request rates modest: these are public but undocumented retailer endpoints and page structures.

## Daily archive on the collector machine

Collection runs on the local collector machine, not in GitHub Actions. The
hosted application is read-only with respect to collected price data: deploy or
mount the resulting `data/archive.db` (or legacy `prices.jsonl`) after a successful local run.

Daily collection scopes (`npm run archive:local`):

- **PAK'nSAVE**: every store (~57). Override with `PAKNSAVE_STORE=Royal Oak`.
- **New World**: every store (~148). Override with `NEWWORLD_STORE=Green Bay`.
- **FreshChoice**: every storefront (~76). Override with
  `FRESHCHOICE_ORIGIN=https://queenstown.store.freshchoice.co.nz`.
- **Woolworths**: every click-and-collect store (~180). Session switches
  pickup store, then scrapes specials for that fulfilment context.
  Override with `WOOLWORTHS_STORE=Queenstown`.
- **The Warehouse**: national online only (no per-store prices).

```sh
npm run paknsave -- archive --all-stores
npm run newworld -- archive --all-stores
npm run freshchoice -- archive --all-stores
npm run woolworths -- archive --all-stores
npm run warehouse -- archive
# single store still works:
# npm run paknsave -- archive "Royal Oak"
# npm run woolworths -- archive --store Queenstown
# npm run freshchoice -- archive --origin https://queenstown.store.freshchoice.co.nz
```

Set `WOOLWORTHS_COOKIE` in the collector machine's environment only if a
different Woolworths fulfilment location is selected in a browser; otherwise
the public-site default is used. Add further location-specific archive runs
only where that retailer exposes a stable public store context.

Schedule those commands using the machine's scheduler (for example `launchd`
on macOS), and publish the archive only after all intended commands finish.
If a collection fails, retain the previous archive and its timestamps rather
than replacing it with a partial result.

`npm run archive:local` implements that rule. It copies the current archive to
a same-directory temporary file, runs every collector against that file,
validates the JSONL, and atomically replaces the live archive only after all
five commands complete. A lock prevents overlapping runs. Optional collector
settings can be stored in a mode-600 environment file and passed via
`COLLECTOR_ENV_FILE`; do not place `WOOLWORTHS_COOKIE` in a plist or logs.

To schedule it at 4:00am on a headless macOS collector (including one reached
over SSH), use a system `LaunchDaemon`, not a GUI `LaunchAgent`:

1. Copy [the daemon template](ops/nz.grocery-prices.archive.daemon.plist.template)
   to `/Library/LaunchDaemons/nz.grocery-prices.archive.plist`.
2. Replace both `/REPLACE/WITH/ABSOLUTE/PATH` values with this repository's
   absolute path, and replace `REPLACE_WITH_COLLECTOR_USERNAME` with the local
   account that owns the repository. Create the referenced `collector.env` with
   `chmod 600`; it may contain `WOOLWORTHS_COOKIE`, `FRESHCHOICE_ORIGIN`, and
   `FRESHCHOICE_STORE_NAME` as `KEY=value` lines.
3. Validate, secure, and load it:

   ```sh
   sudo plutil -lint /Library/LaunchDaemons/nz.grocery-prices.archive.plist
   sudo chown root:wheel /Library/LaunchDaemons/nz.grocery-prices.archive.plist
   sudo chmod 644 /Library/LaunchDaemons/nz.grocery-prices.archive.plist
   sudo launchctl bootstrap system /Library/LaunchDaemons/nz.grocery-prices.archive.plist
   ```

Use `sudo launchctl kickstart -k system/nz.grocery-prices.archive` for a manual
scheduled-job test. The daemon starts the script as the configured collector
user, while `launchd` keeps it available without a GUI login. The standard
output and error logs are in `/tmp` as named by the template.

## Library API

```js
import {
  createObservationRepository,
  PaknsaveClient,
  PriceArchive,
} from "nz-grocery-prices";

const client = new PaknsaveClient();
const [store] = await client.listStores({ query: "Royal Oak" });
const observations = await client.collectDeals({
  storeId: store.id,
  store,
});

const archive = new PriceArchive(
  createObservationRepository("data/archive.db"),
);
await archive.record(observations, { snapshotScope: "specials" });

const currentPromotions = await archive.ongoingSales({
  retailer: "paknsave",
  freshWithinDays: 7,
});

const agentFeed = await archive.agentFeed({
  productIds: ["foodstuffs:5226969-ea-000"],
  minDropPercent: 20,
  baselineDays: 90,
  minSamples: 4,
  includeAllTimeLows: true,
});
```

Retailer clients are exported from the package root and as subpath exports: `nz-grocery-prices/foodstuffs`, `/woolworths`, `/freshchoice`, and `/warehouse`. Collection and storage are separate: `createObservationRepository(path)` picks SQLite (`.db`) or JSONL from the path extension.

Foodstuffs product IDs use the shared `foodstuffs:` namespace, allowing one favourite ID to match that product at both PAK'nSAVE and New World when their source SKU agrees. Other product IDs remain retailer-namespaced; cross-chain matching can use GTINs where retailers publish them. Every collected store is retained as a separate offer for that product, so a favourite can be compared across stores without copying its product metadata.

## Selecting a store

- PAK'nSAVE and New World accept a store name or UUID on every collection command.
- Woolworths' anonymous site defaults to its Glenfield fulfilment store. Set `WOOLWORTHS_COOKIE` to the cookie header from a browser session after selecting another fulfilment location.
- FreshChoice defaults to Queenstown. Set `FRESHCHOICE_ORIGIN`, for example `https://queenstown.store.freshchoice.co.nz`, to use another store's storefront; optionally set `FRESHCHOICE_STORE_NAME`.
- The Warehouse exposes regional availability rather than a physical-store grocery price through this catalogue, so observations are honestly scoped to `warehouse:national-online`.

## Acquisition notes

- The PAK'nSAVE Android package confirmed the mobile specials route used by the Foodstuffs collector. New World uses the same underlying Foodstuffs service with a different banner.
- Woolworths exposes anonymous product-special results for the active fulfilment context.
- FreshChoice publishes store-specific product and specials pages.
- The Warehouse product grid is public, but its anti-bot layer rejects Node's default TLS fingerprint. That adapter uses `curl` through `execFile` by default and also accepts an injected fetch-like transport; it does not execute shell strings.
- `scripts/capture-har.js` can attach to Chrome on port 9222 and write a sanitized HAR. `CAPTURE_URL_MATCH` selects the public tab. Authentication, cookie, and authorization headers are removed.
- Foodstuffs caps broad search result sets at 1,000 products. Use focused `track` queries for favourites instead of treating a broad search as a complete catalogue.

Upstream APIs and HTML are undocumented and may change. Use only data exposed to anonymous shoppers, keep collection personal and low-volume, and review each site's terms before redistributing data.

## Existing NZ grocery projects

Existing consumer tools considered during discovery include [Grocer](https://grocer.nz/), [Baskt](https://baskt.nz/), [PriceStax](https://pricestax.nz/), and [ShopIt](https://shopit.co.nz/). They are useful reference points for comparison shopping. This project takes a different shape: a reusable, local-first Node.js data layer with raw history and an agent-oriented JSON feed rather than another hosted comparison UI.

## Development checks

The project intentionally starts with live-data smoke checks rather than a synthetic test suite. The non-network package checks are:

```sh
npm run check
npm run pack:check
```

```sh
# Full test suite (432+ tests)
npm test

# Run specific test groups
node --test test/sqlite/          # Projection DB rebuild, schema, rollback
node --test test/app/             # Auth, app DB
node --test test/server/          # API contract, security, permissions
node --test test/matching/        # Matching engine (GTIN, source_id, fuzzy)

# Rebuild projection DB (safe — app DB untouched)
npm run build-db

# Run cross-retailer matching
npm run matching
```

### Security

- All SQL is parameterised via `node:sqlite` prepared statements
- Password hashing: `crypto.scrypt` (async, N=16384, r=8, p=1, 16-byte salt)
- Session tokens: 32-byte random, hex-encoded, SHA-256 hashed in DB, 24h expiry
- HTTP-only, SameSite=Strict cookies
- Rate limiting: register (5/min/IP), login (20/min/IP), `Retry-After` header
- Request size limit: 64KB (413 on oversized bodies)
- CSRF: origin/hostname check vs server address
- CORS not needed (same-origin only)

Set `TRUST_PROXY_HEADERS=1` when behind a reverse proxy that sets
`X-Forwarded-Proto`. Set `ENABLE_HSTS=1` to add `Strict-Transport-Security`
headers (requires TLS termination upstream).

### Collector health

Collection health is logged to stdout per run (see `src/collection-health.js`).
Counts per retailer, total archive size, and any failures are recorded. The
archive runner preserves the existing archive on failure.

## Deprecation notice

| Surface | Status |
|---|---|
| **`site/`** | **Live product** — edit here |
| `workbench/projects/grocery-prices` | POINTER stub (moved to `site/`) |
| **`dashboard/`** | Deprecated local JSONL UI |
| Lab SQLite app / matching | **Removed** 2026-07-17 |

New live UI/API → `site/`. Collectors → `src/adapters/` + `scripts/`.
