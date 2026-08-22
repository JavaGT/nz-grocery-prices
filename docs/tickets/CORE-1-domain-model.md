# CORE-1 — Domain model & validation

> **Status (2026-08-23):** Phase 1 COMPLETE — committed `d1e4bfb`.
> `src/domain/observation.js` + tests landed. Fingerprint module initially
> created at `src/domain/fingerprint.js`; per plan v3 [GROK-5] its content
> moves to `src/archive-records.js` in CORE-2 M1 (single canonical home).
> Remaining: append-boundary validation (folded into CORE-2 M2) + adapter
> error-context wrapping (dropped per plan v3 [GROK-9] — adapters keep
> skip-on-incomplete; validation lives at repository.append only).

## Summary
Create `src/domain/` as the single canonical home for the `PriceObservation`
shape: `parseObservation()`, `validateObservation()`, and the stable
`fingerprint()` helpers (moved out of `src/repository.js`). Adapters call
`parseObservation()` so malformed data throws at collection time with retailer
context instead of silently entering the archive.

## Scope
- `src/domain/observation.js` — shape + validation (price cents are
  non-negative integers; promo/member optional but integer when present;
  `product.id`, `store.id`, `observedAt` ISO string required).
- `src/domain/fingerprint.js` — `stable()` + `fingerprint()` (SHA-256 over
  key-sorted JSON), reused by repository.
- Adapter integration: each `to*Observation` wraps its output through
  `parseObservation` (or validation happens once at collector boundary —
  implementer's call, documented in the ticket outcome).

## Constraints
- Zero dependencies. ESM. Validation errors must name the offending field.
- Do not change any valid-data behavior — fingerprints must stay byte-stable
  (archive dedup depends on hash equality across runs).

## Tests
~15 focused cases in `test/domain/`: one invalid fixture per field, plus
fingerprint stability (same object → same hash; key order irrelevant;
`undefined` fields ignored).

## Verification
`npm run check` → `node --test test/domain/` → `npm test`.

## Blocked by
Nothing. First ticket.
