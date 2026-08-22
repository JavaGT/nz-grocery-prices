import { createHash } from "node:crypto";

/**
 * Canonical form of `value` for hashing: arrays map in order, plain objects
 * get keys sorted lexicographically with `undefined`-valued keys omitted,
 * everything else passes through untouched.
 *
 * Semantics are copied verbatim from src/repository.js — do not change
 * behavior here without changing it there too (archive dedup depends on
 * hash equality across runs).
 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

/**
 * Deterministic content hash of `value`: SHA-256 hex digest over the JSON of
 * `stable(value)`. Equal logical content always yields the same digest,
 * regardless of key insertion order.
 */
function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

export { stable, fingerprint };
