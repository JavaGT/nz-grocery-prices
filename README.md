# nz-grocery-prices

A dependency-free Node.js library and CLI for collecting New Zealand grocery prices, keeping a local history, and producing sale data that an agent can use for meal and shopping planning.

It currently has live collectors for the retailers in this priority order:

| Retailer | Price scope | Live support |
| --- | --- | --- |
| PAK'nSAVE | Selected physical store | Stores, search, specials, archive |
| Woolworths NZ | Selected fulfilment store | Specials, archive |
| New World | Selected physical store | Stores, search, specials, archive |
| FreshChoice | Selected store website | Search, specials, archive |
| The Warehouse | National online catalogue | Search, food/drink specials, archive |

Prices are stored as integer NZ cents. Every observation records the retailer, price scope, product source ID, collection time, regular/promotion/member prices, and promotion metadata when available.

## Quick start

Node 20 or newer is required. No runtime packages need to be installed.

```sh
# Discover stores and inspect live results.
npm run paknsave -- stores Auckland
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

## Daily GitHub archive

[`.github/workflows/daily-archive.yml`](.github/workflows/daily-archive.yml) runs the five archive commands at 4:00am `Pacific/Auckland`, commits `data/prices.jsonl`, and can also be started from the Actions tab with **Run workflow**. It has two UTC cron entries and a local-time gate so it follows New Zealand daylight saving time.

The committed defaults match the initial live scopes: PAK'nSAVE Royal Oak, New World Green Bay, FreshChoice Queenstown, The Warehouse Online, and Woolworths' anonymous Glenfield fulfilment store. Configure repository **Actions variables** to select different public scopes:

- `PAKNSAVE_STORE`
- `NEWWORLD_STORE`
- `FRESHCHOICE_ORIGIN`
- `FRESHCHOICE_STORE_NAME`

Set the optional `WOOLWORTHS_COOKIE` Actions secret after choosing a different Woolworths fulfilment location in a browser; otherwise the public site default is used. The workflow needs the repository's Actions setting to permit workflow write permissions, because it commits the archive.

All selected locations append into the same normalized archive, so the same product can accumulate offers from many stores. The included workflow starts with one scope per retailer to keep its daily crawl small and respectful; it is not presented as a complete crawl of every branch nationwide. Add further location-specific archive runs only where that retailer exposes a stable public store context.

On a public repository, standard GitHub-hosted Linux runners are free. A private repository uses the owner account's included Actions minutes; this daily crawl should be monitored from the Actions usage page. GitHub schedules run in UTC, can be delayed under load, and public-repository schedules are disabled after 60 days without repository activity.

## Library API

```js
import {
  JsonlObservationRepository,
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
  new JsonlObservationRepository("data/prices.jsonl"),
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

Retailer clients are exported from the package root and as subpath exports: `nz-grocery-prices/foodstuffs`, `/woolworths`, `/freshchoice`, and `/warehouse`. Collection and storage are separate, so another repository implementation can replace the supplied memory and JSONL repositories.

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
