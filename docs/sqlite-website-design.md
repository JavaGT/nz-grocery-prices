# SQLite website data design

## Decision

Use SQLite for the initial website operational database and retain the existing
append-only JSONL archive as the raw collection record. The implemented first
vertical slice uses Workbench's SQLite database for accounts and private
preferences, and reads the JSONL archive directly for public search/history.
The SQLite price read model below is the next deliberate projection when query
performance or richer filtering warrants importing the archive.

Enable `foreign_keys`, `journal_mode=WAL`, a busy timeout, and one collector
writer. The web server reads through a single application process. This design
must be revisited before multiple independent writers or horizontally scaled
API servers are required.

## Boundaries

The existing archive vocabulary remains authoritative:

```text
product revision + store revision + offer revision + special snapshot
  -> imported price observation/read model -> user-facing deal signal
```

Never overwrite a collected fact to make a current view easier. Corrections are
new imported facts; current offers and deal signals are rebuildable projections.

## Initial tables

| Table | Purpose | Key constraints / indexes |
| --- | --- | --- |
| `import_runs` | JSONL import provenance and status | source path/hash, started/finished timestamps, status |
| `retailers` | Retailer identity | unique slug |
| `price_contexts` | Exact collected location/scope | retailer + source store id unique; `scope_kind` is physical-store, pickup, store-site, or national-online |
| `products` | Current indexed representation of a retailer product | product ID primary key; name/brand/category/search text/image |
| `product_revisions` | Immutable product metadata revisions | product ID + revision hash unique |
| `store_revisions` | Immutable price-context revisions | price context ID + revision hash unique |
| `offer_revisions` | Immutable price/promotion/source revisions | product ID + price context ID + revision hash unique |
| `special_snapshots` | Advertised-special listing deltas | price context + collected time index |
| `price_observations` | Query projection of imported offer history | product ID + context ID + observed time index; integer NZ cents only |
| `product_matches` | Auditable cross-retailer equivalence candidates | pair unique, match method/confidence/review state |
| `deal_signals` | Rebuildable price-history conclusions | product/context + calculation version + calculated time index |
| `users` | Account identity | Workbench-managed unique username/password identity |
| `user_store_preferences` | Selected and ranked price contexts | user/context unique; rank index |
| `saved_searches` | Named private search criteria | user + normalised query unique |
| `watch_list_entries` | A user watches a product, category, or saved search | one target kind per row; unique user/target |
| `schema_migrations` | Applied schema versions | migration ID primary key |

`price_observations` is a read projection, not a competing archive. It must
store the source revision IDs needed to trace every displayed field back to an
import run and raw archive record.

## Search and signals

Use an FTS5 virtual table over product name, brand, categories, and description
for the first release. Store product IDs, never duplicate mutable product state
as the FTS authority. Semantic embeddings are a later additive index: write an
embedding table keyed by product revision hash and calculate similarity in the
application until a measured need justifies a vector extension or PostgreSQL.

`deal_signals` records the calculation inputs: baseline window, minimum sample
count, price policy, result kind, reference price, calculated price, and
algorithm version. A result is only present when enough qualifying history
exists. Current advertised promotions are queried independently, including when
history is sparse.

## Privacy and safety

SQLite has no row-level security. Every user-owned read/write query must filter
by authenticated user ID in the application. The MVP stores no public user
content. User text is size-limited, normalised for search, parameter-bound in
SQL, and escaped on display.

## Migration and backup rules

- Migrations are ordered, idempotency-checked, and recorded in
  `schema_migrations`.
- Apply a migration before starting the HTTP listener; never serve against a
  partially migrated schema.
- Import in transactions. A failed import records failure and does not expose
  partial current-offer projections.
- Back up the SQLite database and raw JSONL independently. Either must be able
  to rebuild the website read model when paired with migration code.

## Revisit triggers

Move to PostgreSQL when an actual deployment requires more than one independent
writer, horizontally scaled application instances writing to the same database,
database-enforced row isolation, or search/vector workload that SQLite cannot
meet under measured load.
