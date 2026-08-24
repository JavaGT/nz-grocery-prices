# nz-grocery-prices

A local-first New Zealand grocery price intelligence application. It collects supermarket prices over the long term, preserves a durable historical archive, and helps each user find meaningful savings on the products, categories, and searches they care about. The resulting data can also power meal planning, shopping lists, and other agent-assisted decisions.

The application is intended to support user accounts. Each user will be able to follow individual products, product categories, and saved search terms; mark favourite stores; and receive a focused view of relevant price changes and promotions. Store preferences should make it possible to prioritise nearby or preferred locations while still comparing the same item across retailers.

It currently has live collectors for the retailers in this priority order:

| Retailer | Price scope | Live support |
| --- | --- | --- |
| PAK'nSAVE | Selected physical store | Stores, search, specials, archive |
| Woolworths NZ | Selected fulfilment store | Specials, archive |
| New World | Selected physical store | Stores, search, specials, archive |
| SuperValue | Selected store | Planned: stores, search, specials, archive |
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

## Quick start

### App server (price·minder)

Node 20+ required. No runtime packages need to be installed. SQLite is
built into Node 26.3.1+ (`node:sqlite`). For older Node 20+, rebuild
still works; the app server requires Node 26+ for `node:sqlite`.

```sh
# Build the projection database from the JSONL archive
npm run build-db

# Start the app server (default port 3010)
npm start

# Or specify custom paths and port
PORT=3010 JSONL_PATH=data/prices.jsonl node src/app/server.js
```

The server serves:
- **API** at `/api/` — deals, products, stores, search, health (public)
- **Auth API** at `/api/auth/` — register, login, logout
- **Private API** at `/api/` — watch list, preferred stores, saved searches, new products
- **SPA** at `/` — price·minder frontend (static HTML+JS, see `public/`)

Environment variables:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3010` | HTTP listener port |
| `HOST` | `127.0.0.1` | Listen address |
| `JSONL_PATH` | `data/prices.jsonl` | Authoritative archive path |
| `PRICES_DB` | `data/prices.db` | Projection DB path (rebuildable) |
| `APP_DB` | `data/app.db` | Application DB path (auth, prefs, user data) |

### Two-DB lifecycle

- **`data/prices.db` (projection DB):** A rebuildable read-only materialization
  of the JSONL archive. Created by `npm run build-db` or on first app startup.
  Destroy and rebuild at any time — it contains NO user data.
- **`data/app.db` (application DB):** Persistent user data (accounts, sessions,
  watch lists, saved searches, preferred stores, product match pairs). NEVER
  rebuilt from JSONL. Preserved across rebuilds. Backup regularly.

The app server opens both databases at startup:
1. Open `data/app.db` (create if absent), apply pending app migrations
2. Open `data/prices.db` (create if absent), verify fingerprint, rebuild if stale
3. Start HTTP listener

### Matching (cross-retailer product linking)

Product matching uses a two-DB pipeline:

1. **Matching engine** (`src/matching/`): Reads products from the projection DB,
   finds matches by shared GTIN, shared Foodstuffs source IDs, or fuzzy name
   similarity, and writes results to `data/app.db` → `product_match_pairs`.
2. **Public API** reads match truth from `data/app.db`:
   - `review_state: 'confirmed'` → returned as `matches` (confirmed facts:
     auto_gtin, auto_source_id, human_reviewed)
   - `review_state: 'candidate'` → returned as `candidates` (fuzzy suggestions,
     never auto-confirmed)
   - `review_state: 'rejected'` → excluded

Run matching after building the projection DB:

```sh
# Auto-match by GTIN and shared source_id only
npm run matching

# Include fuzzy candidate generation (slower)
npm run matching -- --fuzzy
```

Matching CLI options: `--prices-db <path>` (default `data/prices.db`),
`--app-db <path>` (default `data/app.db`), `--fuzzy` (include fuzzy candidates).

### Deals (runtime computation)

Deal signals are computed **at runtime** from offer data, not from a pre-built
table. The `GET /api/deals` endpoint calls `calculateSales()` and
`calculateOngoingSales()` from `src/analytics.js` with a 90-day baseline,
3-sample minimum, and 7-day freshness window. No rebuild step is required
for deals to reflect the latest data.

**Truth semantics (MUST-11 constraint):**
- An advertised deal requires `promo_cents < regular_cents` — a concrete
  retailer-reported reduction. Equal-price "NEW_PRICE" promotions are explicitly
  excluded (they are shelf price changes, not deals).
- A history-backed deal requires at least 3 prior observations within the
  90-day baseline window and a current price below the baseline average.
  Products with insufficient history are correctly excluded.
- Member-only prices are not shown as deals under the default `public` price
  policy. The analytics support `member` policy for future use.
- Offers where `promo_cents > regular_cents` are never classified as deals.

The legacy `deal_signals` and `product_matches` tables in the projection DB
schema (`001_initial.sql`) are retained for compatibility but are **not**
populated by any current pipeline. Source of truth for cross-retailer matching
is `product_match_pairs` in `data/app.db`.

### Collector commands (existing, unchanged)

Discover stores and inspect live results:

```sh
npm run paknsave -- deals "Royal Oak" --pages 1
npm run newworld -- search "Green Bay" butter --json
npm run woolworths -- deals --pages 1
npm run freshchoice -- search butter --pages 1
npm run warehouse -- deals --pages 1
```

Archive the complete advertised-specials snapshot for each retailer:

```sh
npm run paknsave -- archive "Royal Oak"
npm run newworld -- archive "Green Bay"
npm run woolworths -- archive
npm run freshchoice -- archive
npm run warehouse -- archive
```

The default archive is `data/prices.jsonl`. It is a change-only, append-only JSONL archive: a product revision is stored once by content hash, prices are stored as product/store offers, and each daily archive records only a compact special-listing delta for each store. An unchanged daily run therefore adds just one snapshot record per collected store, rather than duplicating the whole catalogue. Use `--file path/to/prices.jsonl` to select another archive.

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

Run `npm run compact` to remove duplicate records after an interrupted/manual ingestion. Archives containing legacy v1 records must be converted first with `node scripts/migrate-v1-archive.js --file <archive.jsonl>` (dry-run reports what would change; it refuses to touch the live archive without `--force`).

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
mount the resulting `data/prices.jsonl` archive after a successful local run.

Daily collection scopes (`npm run archive:local`):

- **PAK'nSAVE**: every store (~57). Override with `PAKNSAVE_STORE=Royal Oak`.
- **New World**: every store (~148). Override with `NEWWORLD_STORE=Green Bay`.
- **FreshChoice**: every storefront (~76). Override with
  `FRESHCHOICE_ORIGIN=https://queenstown.store.freshchoice.co.nz`.
- **Woolworths**: one fulfilment store (anonymous Glenfield by default). No
  public multi-store API — cookie/session picks the store.
- **The Warehouse**: national online only (no per-store prices).

```sh
npm run paknsave -- archive --all-stores
npm run newworld -- archive --all-stores
npm run freshchoice -- archive --all-stores
npm run woolworths -- archive
npm run warehouse -- archive
# single store still works:
# npm run paknsave -- archive "Royal Oak"
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

The package root (`nz-grocery-prices`) exports a small, stable surface:
`PriceArchive`, `JsonlObservationRepository`, `MemoryObservationRepository`,
`parseObservation`, `calculateSales`, `calculateOngoingSales`,
`buildPriceSeries`, and `toAgentFeed`. Types live in `src/index.d.ts`.

### Quickstart

Record observations into an archive, then query history, sales, and the
agent feed:

```js
import {
  JsonlObservationRepository,
  MemoryObservationRepository,
  PriceArchive,
  parseObservation,
} from "nz-grocery-prices";

// Pick a repository: durable JSONL file, or in-memory for tests.
const repository = process.env.ARCHIVE
  ? new JsonlObservationRepository(process.env.ARCHIVE)
  : new MemoryObservationRepository();
const archive = new PriceArchive(repository);

// Record: validate, then persist (deduplicated per offer revision).
const observation = parseObservation({
  product: { id: "foodstuffs:5226969-ea-000", name: "Butter 500g", brand: "Anchor" },
  store: { id: "paknsave:001", retailer: "paknsave", name: "Royal Oak" },
  price: { currency: "NZD", regularCents: 500, promoCents: 350 },
  observedAt: new Date().toISOString(),
  promotion: { savePercent: 30 },
  source: { retailerProductId: "5226969-ea-000", adapter: "foodstuffs-paknsave" },
});
await archive.record([observation], { snapshotScope: "specials" });

// Sales detection compares against history, so record a cheaper follow-up:
const cheaper = parseObservation({
  ...observation,
  price: { currency: "NZD", regularCents: 500, promoCents: 299 },
  observedAt: new Date(Date.now() + 86_400_000).toISOString(),
});
await archive.record([cheaper], { snapshotScope: "specials" });

// Query.
const history = await archive.history({ productId: observation.product.id });
const revisions = await archive.productHistory(observation.product.id);
const sales = await archive.findSales({ minDropPercent: 20 });   // vs baseline
const ongoing = await archive.ongoingSales({ retailer: "paknsave" }); // advertised
const feed = await archive.agentFeed({});                        // agent JSON

// Or call the pure functions directly (deterministic: pass at explicitly):
// calculateSales(observations, { at }), calculateOngoingSales(...),
// buildPriceSeries(observations), toAgentFeed(sales, generatedAt).
```

### API

| Export | Purpose |
| --- | --- |
| `PriceArchive` | Facade over a repository: `record`, `history`, `productHistory`, `findSales`, `ongoingSales`, `agentFeed`. Injects time so analytics stay pure. |
| `JsonlObservationRepository` | Durable append-only JSONL archive: locking, fsynced appends, atomic compaction, tail-tolerant load, v1 refusal. |
| `MemoryObservationRepository` | In-memory repository for tests; same query interface. (`append()` returns observations stored, vs archive records written for the JSONL repository.) |
| `parseObservation` | Validates one observation or throws `TypeError` naming every problem. |
| `calculateSales` | History-backed drops from the recent baseline (needs explicit `at`). |
| `calculateOngoingSales` | Currently-advertised promotions (needs explicit `at`). |
| `buildPriceSeries` | Per-offer effective-price histories with promotion-aware points. |
| `toAgentFeed` | Renders sales into the stable two-list agent feed. |

Retailer clients are not at the root; import them from the subpath exports
`nz-grocery-prices/foodstuffs`, `/woolworths`, `/freshchoice`, and
`/warehouse` (see each `src/adapters/*.d.ts`). Collection and storage are
separate, so another repository implementation can replace the supplied
memory and JSONL repositories.

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
# Full test suite (600+ tests)
npm test

# Run specific test groups
node --test test/sqlite/          # Projection DB rebuild, schema, rollback
node --test test/app/             # Auth, app DB
node --test test/server/          # API contract, security, permissions
node --test test/matching/        # Matching engine (GTIN, source_id, fuzzy)

# Rebuild projection DB (safe — app DB untouched; refuses app.db outputs)
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

## Legacy formats and the old dashboard (removed 2026-08-24)

Per owner direction ("no hangups on legacy"), the legacy v1 support paths and
the old `dashboard/` server are **removed**:

- The `dashboard/` directory, its `npm run dashboard` script, and
  `test/server.test.js` were deleted. The canonical server is `npm start`
  (`src/app/server.js`) — SQLite projection + user accounts.
- Legacy v1 whole-observation records are **rejected** by the archive loader,
  compaction, and the projection rebuild with an error pointing at the
  migrator. Convert them once with:

  ```sh
  node scripts/migrate-v1-archive.js --file <archive.jsonl> --dry-run  # report only
  node scripts/migrate-v1-archive.js --file <archive.jsonl>            # migrate (backs up first)
  ```

  The migrator preserves valid v2 lines byte-for-byte in order, derives v2
  records from each v1 observation against all preceding state, quarantines
  undecodable lines rather than inventing data, and writes a fsynced backup
  before atomically replacing the file. A run with no v1 lines is a no-op.
