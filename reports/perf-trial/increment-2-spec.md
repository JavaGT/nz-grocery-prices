# Increment 2 spec — flip `/api/deals` to read materialized signals

Status: NOT STARTED (increment 1 — schema + rebuild materialization + parity
test — is merged to main; `deal_signals` is populated and parity-proven).
Estimated effort: 40-60 minutes including full-suite verification.

## Why

Cold `/api/deals` currently costs ~40ms (analytics + observation
materialization) per compute, and grows linearly with archive age. Reading
the rebuild-populated `deal_signals` table reduces that to a few ms of
indexed reads, flat at any archive age. The parity test
(`test/sqlite/deal-materialization.test.js`) already proves stored rows ==
runtime output, so the flip is semantically safe.

## Changes

1. `src/server/handlers/public.js` — `dealUniverse`:
   - Replace the 90-day observation query + `calculateSales` +
     `calculateOngoingSales` + mapping with a single signal SELECT:
     ```sql
     SELECT ds.signal_kind, ds.reference_cents, ds.current_cents,
            ds.drop_percent, ds.calculated_at,
            p.name AS product_name, p.brand AS product_brand,
            p.category AS product_category, p.image_url AS product_image,
            pc.retailer_id, pc.store_id, pc.store_name
     FROM deal_signals ds
     JOIN products p ON p.id = ds.product_id
     JOIN price_contexts pc ON pc.id = ds.context_id
     WHERE pc.retailer_id = ?        -- only when retailer param present
     ```
   - Map rows to `historyBacked` (kinds `history_drop`/`all_time_low`) and
     `advertised` (`advertised_only`) exactly as listDeals did:
     - `signal.kind` = signal_kind; `dropPercent` = drop_percent;
       `referenceCents` = reference_cents (also `cents.regular`);
       `currentCents`; `calculatedAt` = ISO of calculated_at.
     - savingsText: drop_percent > 0 → `${Math.round(drop_percent)}% off`,
       else `All-time low` (history path); advertised rows always have
       drop_percent > 0 (build filters savePercent <= 0).
   - Keep everything else untouched: per-retailer TTL cache, dbSignature
     invalidation, single-flight, CachedResponse tokens, filter/limit,
     tier bucketing (copies), dedupe, sort.
   - The `queryDbObservations` / `defaultQueryDbObservations` seam becomes
     unused by the handler. Replace the constructor seam with
     `queryDealSignals(db, retailer)` (default = real loader) so the
     deals-cache unit tests keep a counting seam; delete
     `defaultQueryDbObservations` if nothing else imports it (grep first).
2. `src/app/server.js` + `test/server/server-helpers.js`: stop passing
   `queryDbObservations` (pass nothing, or the new seam name).
3. Test updates:
   - `test/server/deals-cache.test.js`: fixtures become SIGNAL rows (much
     simpler than observation chains — one row per deal); keep the same
     assertions (TTL, per-retailer, single-flight, no-mutation,
     CachedResponse token/maxAge).
   - `test/server/handler-sql-audit.test.js`: replace the deals-window
     SELECT pin with the signal SELECT pin.
   - `test/server/query-observations.test.js`: repoint at
     `deal-materialization.js`'s observation query, or delete if redundant
     with `test/sqlite/deal-materialization.test.js`.
   - ORACLE (must pass UNMODIFIED): `test/server/public-api.test.js` deals
     tests — they build real fixtures through rebuild + materialization and
     assert response shapes; if they pass without edits, the flip is
     behavior-preserving. Feed endpoint (`src/app/feed*`) is out of scope.

## Verification

`npm run check`; `node --test test/server/*.test.js`; full `npm test`
(0 failures); `npm run bench` after building a deals-rich DB (re-timestamp
a breadth archive +51d like lane F3 did) — cold deals should drop from
~46ms to <5ms and stay flat as the archive ages.
