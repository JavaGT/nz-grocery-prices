import { createHash } from "node:crypto";

/**
 * Canonical form of `value` for hashing: arrays map in order, plain objects
 * get keys sorted lexicographically with `undefined`-valued keys omitted,
 * everything else passes through untouched.
 *
 * The key sort is locale-pinned (`localeCompare(key, "en")`) so digests are
 * identical on every machine. Byte-parity with the original locale-less sort
 * was proven over the pinned-digest fixtures and every v2 record in the live
 * archive before adoption (archive key sets are ASCII, where both orders
 * agree). Do not change this behavior without a migration plan — archive
 * dedup depends on hash equality across runs.
 */
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right, "en"))
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

/** Content hash of a product revision payload (archive dedup identity). */
function productRevisionHash(data) {
  return fingerprint(data);
}

/** Content hash of a store revision payload (archive dedup identity). */
function storeRevisionHash(data) {
  return fingerprint(data);
}

/** Content hash of an offer revision payload (price/promotion/source). */
function offerRevisionHash(data) {
  return fingerprint(data);
}

const RECORD_TYPES = new Set(["product", "store", "offer", "snapshot"]);

function requireId(problems, record, field) {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    problems.push(`${record.type} record ${field} must be a non-empty string`);
  }
}

/**
 * Returns every envelope problem with `record` as a v2 archive record
 * (version, known type, the id fields that type carries). An empty array
 * means the envelope is valid. Payload hashes are NOT checked here — the
 * loader verifies those separately and treats mismatches as defects, not
 * hard errors.
 */
export function validateRecordEnvelope(record) {
  const problems = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return ["record must be an object"];
  }
  if (record.version !== 2) {
    problems.push("record version must be 2");
  }
  if (!RECORD_TYPES.has(record.type)) {
    problems.push(`record type must be one of ${[...RECORD_TYPES].join(", ")}`);
    return problems;
  }
  if (record.type === "product") requireId(problems, record, "productId");
  if (record.type === "store") requireId(problems, record, "storeId");
  if (record.type === "offer") {
    requireId(problems, record, "offerId");
    requireId(problems, record, "productId");
    requireId(problems, record, "storeId");
  }
  if (record.type === "snapshot") {
    requireId(problems, record, "scope");
    requireId(problems, record, "storeId");
  }
  return problems;
}

/**
 * Canonical single-line encoding of a v2 record (no trailing newline — the
 * writer joins lines). Throws TypeError on an invalid envelope so malformed
 * records can never reach disk through this path.
 */
function encodeRecord(record) {
  const problems = validateRecordEnvelope(record);
  if (problems.length > 0) {
    throw new TypeError(`Invalid archive record: ${problems.join("; ")}`);
  }
  return JSON.stringify(record);
}

/**
 * Decodes one archive line into a v2 record. Throws TypeError naming the
 * envelope problems (or a SyntaxError from JSON.parse for malformed JSON).
 * Callers attach file:line context.
 */
function decodeRecord(line) {
  const record = JSON.parse(line);
  const problems = validateRecordEnvelope(record);
  if (problems.length > 0) {
    throw new TypeError(`Invalid archive record: ${problems.join("; ")}`);
  }
  return record;
}

/**
 * True for legacy v1 observations: the unversioned whole-observation shape
 * (product + store + price + source, no version field).
 */
function isV1Record(record) {
  return Boolean(
    record &&
    typeof record === "object" &&
    record.version === undefined &&
    record.product &&
    record.store &&
    record.price &&
    record.source,
  );
}

export {
  encodeRecord,
  decodeRecord,
  fingerprint,
  isV1Record,
  offerRevisionHash,
  productRevisionHash,
  stable,
  storeRevisionHash,
};
