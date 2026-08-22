# CORE-1 — Domain model & validation

> **Status: COMPLETE (2026-08-23).** Phase 1 committed `d1e4bfb`
> (`src/domain/observation.js` + 31 tests). Append-boundary validation landed
> as CORE-2 M2 (`e16a39f`). Adapter-level throwing dropped by design per plan
> v3 [GROK-9] — adapters keep skip-on-incomplete; validation lives at
> `repository.append`. Fingerprint relocated to `src/archive-records.js`
> (CORE-2 M1, `bd8ae37`) per [GROK-5] single-canonical-home rule.

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
