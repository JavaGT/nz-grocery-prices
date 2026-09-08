import { createHash } from "node:crypto";

/**
 * Sorted-key-order memo for stable(): archive payloads come from a handful
 * of fixed producer shapes, so the same key sequences recur on nearly every
 * object instance. The locale-pinned sort (ICU collation — the expensive
 * part) then runs once per distinct sequence instead of once per instance.
 * The signature is `JSON.stringify(keys)`, which is injective, so even a
 * key containing "\u0000"-like content can never alias another sequence.
 *
 * Equivalence with filter-then-sort (the previous shape): keys of one object
 * are unique; a stable sort of the full sequence assigns tied keys ranks in
 * the sequence's own order, and filtering preserves relative order — so
 * walking the full sorted order and skipping undefined values yields exactly
 * the previous filtered-then-sorted order, including localeCompare ties.
 * Bounded so adversarial dynamic-key payloads cannot grow it without limit;
 * past the limit sorting falls back to per-call (still correct, just slow).
 */
const KEY_ORDER_CACHE_LIMIT = 8192;
const keyOrderCache = new Map();

function sortedKeyOrder(keys) {
  const signature = JSON.stringify(keys);
  let sorted = keyOrderCache.get(signature);
  if (sorted === undefined) {
    sorted = [...keys].sort((left, right) => left.localeCompare(right, "en"));
    if (keyOrderCache.size < KEY_ORDER_CACHE_LIMIT) keyOrderCache.set(signature, sorted);
  }
  return sorted;
}

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
    const entries = [];
    for (const key of sortedKeyOrder(Object.keys(value))) {
      const child = value[key];
      if (child !== undefined) entries.push([key, stable(child)]);
    }
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * Quote `string` like JSON.stringify would. Fast path: strings with no
 * escapable characters (controls, quote, backslash) need no ICU/escape
 * machinery — wrap them in quotes directly.
 */
const NEEDS_ESCAPE = /[\u0000-\u001f"\\]/;

function quoteJsonString(value) {
  return NEEDS_ESCAPE.test(value) ? JSON.stringify(value) : `"${value}"`;
}

/**
 * True for JS "array index" keys: canonical numeric strings 0..2^32-2.
 * Objects built via Object.fromEntries order these numerically BEFORE all
 * string keys, so the canonical JSON they stringify to does too — the
 * serializer below must reproduce that, not a pure locale order.
 */
function isArrayIndexKey(key) {
  if (!/^(0|[1-9][0-9]*)$/.test(key)) return false;
  return Number(key) < 4294967295; // indices run 0..2^32-2 inclusive
}

/**
 * Serializes `value` to EXACTLY the bytes of JSON.stringify(stable(value))
 * without building the intermediate canonical object:
 * objects emit integer-like keys in ascending numeric order first (the
 * order Object.fromEntries produces — see isArrayIndexKey), then the
 * memoized locale-pinned string-key order, skipping undefined values;
 * arrays keep order with undefined elements as `null`; finite numbers
 * serialize as ToString (identical to JSON's number form, with
 * NaN/Infinity as `null`); strings fast-path quoting; anything exotic
 * (bigint/symbol/function/undefined-at-top-level) is delegated to
 * JSON.stringify so errors and return values match it exactly.
 */
function canonicalJson(value) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return quoteJsonString(value);
    case "number":
      return Number.isFinite(value) ? String(value) : "null";
    case "boolean":
      return value ? "true" : "false";
    case "object": {
      if (Array.isArray(value)) {
        let out = "[";
        for (let index = 0; index < value.length; index += 1) {
          if (index > 0) out += ",";
          const item = value[index];
          out += item === undefined ? "null" : canonicalJson(item);
        }
        return `${out}]`;
      }
      const indexKeys = [];
      const stringKeys = [];
      for (const key of Object.keys(value)) {
        if (isArrayIndexKey(key)) indexKeys.push(key);
        else stringKeys.push(key);
      }
      let out = "{";
      let first = true;
      const emit = (key) => {
        const child = value[key];
        if (child === undefined) return;
        if (!first) out += ",";
        first = false;
        out += `${quoteJsonString(key)}:${canonicalJson(child)}`;
      };
      for (const key of indexKeys) emit(key); // Object.keys order = numeric ascending
      for (const key of sortedKeyOrder(stringKeys)) emit(key);
      return `${out}}`;
    }
    default:
      // undefined → JSON.stringify returns undefined (hash.update then
      // throws, as before); bigint/symbol/function → the identical
      // "not serializable" TypeError.
      return JSON.stringify(value);
  }
}

/**
 * Deterministic content hash of `value`: SHA-256 hex digest over the JSON of
 * `stable(value)`. Equal logical content always yields the same digest,
 * regardless of key insertion order.
 */
function fingerprint(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
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
 * Classifies one successfully-parsed archive line WITHOUT applying it:
 * `{ status: "v2", record }` for a valid v2 record, `{ status: "legacy",
 * record }` for a legacy v1 whole-observation, or `{ status: "invalid",
 * problems }` for anything else. Shared by the repository loader and the
 * repair CLI so both apply identical record-validity semantics. The v1
 * predicate is checked first — v1 records carry no version field, so the
 * envelope check alone would mislabel them.
 */
export function classifyParsedRecord(record) {
  if (isV1Record(record)) return { status: "legacy", record };
  const problems = validateRecordEnvelope(record);
  if (problems.length === 0) return { status: "v2", record };
  return { status: "invalid", problems };
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

/**
 * Deep copy of a plain-JSON value (observations, record payloads): faster
 * than structuredClone for the small nested objects that dominate append
 * planning. Exactly equivalent for every input — anything that is not an
 * array or a plain object (class instances, Dates, Maps, null-prototype
 * objects, cross-realm objects) falls back to structuredClone itself, and
 * holes, undefined values, and integer-like key order are all preserved by
 * the recursive copy. Only cycles differ: structuredClone rejects them with
 * DataCloneError, this walks until the stack overflows — callers that can
 * receive cyclic input must keep using structuredClone.
 */
function cloneJson(value) {
  if (Array.isArray(value)) {
    const copy = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      copy[index] = cloneJson(value[index]);
    }
    return copy;
  }
  if (value !== null && typeof value === "object") {
    if (value.constructor !== Object) return structuredClone(value);
    const copy = {};
    for (const key of Object.keys(value)) {
      copy[key] = cloneJson(value[key]);
    }
    return copy;
  }
  return value;
}

export {
  cloneJson,
  encodeRecord,
  decodeRecord,
  fingerprint,
  isV1Record,
  offerRevisionHash,
  productRevisionHash,
  stable,
  storeRevisionHash,
};
