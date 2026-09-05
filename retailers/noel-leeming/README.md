# Noel Leeming — campaign adapter

- **retailer id:** `noel-leeming` · **category:** consumer electronics
- **platform:** SFCC, classic `updategrid` (same family as The Warehouse)
- **status:** implemented, live-verified 2026-09-06
- **store scope:** `noel-leeming:online` (national online pricing)

## API discovery notes

- `Search-UpdateGrid` 301-redirects to `/search/updategrid` — the exact
  endpoint the existing Warehouse adapter consumes — and the product tiles
  carry the identical `data-gtm-product` JSON payload, so this adapter
  reuses `parseWarehouseProducts`/`toSfccObservation` from `src/adapters`.
- **Node's fetch gets 403 (TLS fingerprinting) while curl passes**, so the
  client defaults to the curl subprocess transport (`_lib/curl-transport.js`),
  exactly like the warehouse adapter's execFile rule. Tests inject `fetch`.

## Endpoints used

| What | Endpoint |
|---|---|
| category grid (paginated) | `GET /search/updategrid?cgid=<category>&start=N&sz=48` |

Categories walked (`/c/<cgid>` nav-verified): `appliances`, `audio`,
`computers-office-tech`, `gaming`, `home-entertainment`,
`mobile-smart-devices`, `photo-video`, `smart-home`, `hot-deals`.

## Field mapping

| Payload | PriceObservation |
|---|---|
| GTM JSON `id` / `name` / `brand` / `productEAN` | product identity/brand/gtin |
| GTM `price` / `productThenPrice` | `regularCents` / `promoCents` + promotion |
| GTM `promotionCallOutMessage` (multibuy) | promotion type MULTIBUY + threshold |
| GTM `category` slash path | `product.categories` |
| tile link | `source.url` |

## Verification (2026-09-06)

`node retailers/noel-leeming/collect.js --stdout --max-pages 1` produced 96
valid observations. Sample: `noel-leeming:N244629` "Russell Hobbs Satisfry
Air Fryer 5.5L" $89.00, gtin 9322219033237.

## Quirks

- Every category page declares its total ("1 – 24 of N products"); the walk
  stops on the declared total or the first all-duplicate page.
- `cgid` values are the `/c/...` URL slugs (e.g. `televisions` is valid only
  if it appears under `/c/`; verify against the nav before adding).
