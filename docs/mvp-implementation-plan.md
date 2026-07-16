# MVP implementation plan

## Status

Superseded as the immediate implementation sequence on 2026-07-16. The first
vertical slice now lives in `workbench/projects/grocery-prices`, uses
Workbench's built-in username/password sessions and SQLite for private data,
and reads the existing JSONL archive directly. Retain the SQLite import/read
model steps below as the next scale-up plan; do not start them before measuring
the direct archive path.

## Scope and sequence

This plan adds public product search/comparison/history and private store
preferences/watch lists. It does not implement the deferred social product.

| Step | Change | Files | Verification |
| --- | --- | --- | --- |
| 1 | Add and pin the chosen SQLite Node driver in `package.json`, then add a migration runner and SQLite connection helper with foreign keys, WAL, busy timeout, and transaction wrapper. Extend `npm run check` to parse all `dashboard/**/*.js` files. `001_initial.sql` creates every initial table in `docs/sqlite-website-design.md`, including immutable archive tables, `price_observations`, `deal_signals`, and user-preference tables. | `dashboard/db.js`, `dashboard/migrations/001_initial.sql`, `dashboard/server.js`, `package.json`, `test/db.test.js` | `node --test test/db.test.js`; open a new database and assert expected pragmas/tables; `npm run check`. |
| 2 | Create small v2 JSONL archive fixtures covering product/store/offer revisions, special snapshots, changed prices, sparse history, and a stale collection. Import them into the initial provenance-preserving SQLite tables and record import status. | `dashboard/import-archive.js`, `dashboard/db.js`, `test/fixtures/archive-v2.jsonl`, `test/import-archive.test.js` | `node --test test/import-archive.test.js`; import a fixture twice and assert no duplicate immutable records. |
| 3 | Build query functions for stores, products, current offers, product history, freshness, and deal signals. | `dashboard/queries.js`, `dashboard/import-archive.js`, `test/queries.test.js` | `node --test test/queries.test.js`; fixture covers zero, one, and multiple offers plus stale data. |
| 4 | Replace dashboard read endpoints with SQLite-backed public endpoints and add explicit context/freshness fields. | `dashboard/server.js`, `dashboard/queries.js`, `test/server.test.js` | `node --test test/server.test.js`; API contract checks price context and stale/insufficient-history states. |
| 5 | Add FTS5 product search and ranked closest-match results. | `dashboard/migrations/002_product_search.sql`, `dashboard/queries.js`, `dashboard/server.js`, `test/search.test.js` | `node --test test/search.test.js`; exact and ordinary-language queries return expected products. |
| 6 | Add minimal account/session boundary plus private store preferences, saved searches, and watch-list API. | `dashboard/auth.js`, `dashboard/queries.js`, `dashboard/server.js`, `dashboard/migrations/003_user_preferences.sql`, `test/preferences.test.js` | `node --test test/preferences.test.js`; unauthenticated writes fail; user A cannot read user B’s entries. |
| 7 | Update the existing dashboard UI: public best-deals homepage and search/product comparison first, then signed-in watch-list/deal-ledger states. | `dashboard/public/index.html`, `dashboard/public/app.js`, `dashboard/public/api.js`, `dashboard/public/views/browse.js`, `dashboard/public/views/product.js`, `dashboard/public/views/deals.js`, `dashboard/public/views/favorites.js` | `npm run check && npm test`; manual browser smoke: best-deals landing view, search, product context, stale label, preference, watch list. |
| 8 | Add operational checks: backup/export, failed-import reporting, and migration startup behaviour. | `dashboard/backup.js`, `dashboard/server.js`, `package.json`, `test/server.test.js` | `node --test test/server.test.js`; failed import retains prior completed read model and migration failure prevents serving. |

## Dependency gates

Do not start user preferences before the SQLite connection/migration/test
foundation exists. Do not change the UI before the public API returns exact
price context, provenance/freshness, and deliberate empty states. Do not expose
semantic search or social features in this milestone.

## Quality gates

After steps 2, 4, 6, and 8 run the relevant focused tests plus `npm run check`.
Before merging the milestone, run `npm test`, `npm run check`, and
`npm run pack:check`. The existing JSONL-based archive and command-line tests
must continue to pass throughout.

## Open implementation choices

- Authentication provider/session approach is intentionally unchosen; it must
  support a stable internal user ID and HTTP-only session handling.
- Select a SQLite Node driver compatible with the project deployment environment
  at the start of step 1, pin it in `package.json`, and add the migration test
  before any query or API work begins.
- Product images use existing retailer-supplied image metadata; no image
  copying pipeline is in MVP.
