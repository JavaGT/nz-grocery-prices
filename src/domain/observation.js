/**
 * Canonical validation for the PriceObservation shape.
 *
 * Required: product.id, store.id, store.retailer (non-empty strings),
 * observedAt (ISO 8601 string parseable by Date.parse),
 * price.regularCents (non-negative integer),
 * source.retailerProductId (non-empty string).
 *
 * Optional but constrained when present: price.promoCents and
 * price.memberCents (non-negative integers); promotion (object whose
 * startsAt/endsAt are ISO strings and whose savePercent is a finite number).
 *
 * Unknown extra fields are allowed everywhere (forward compatibility).
 */

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function isIsoString(value) {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/** Pushes a problem naming `path` unless `value` is a non-empty string. */
function requireNonEmptyString(problems, value, path) {
  if (!isNonEmptyString(value)) {
    problems.push(`${path} must be a non-empty string`);
  }
}

/** Pushes a problem naming `path` unless `value` is absent or a valid integer. */
function checkOptionalCents(problems, value, path) {
  if (value !== undefined && !isNonNegativeInteger(value)) {
    problems.push(`${path} must be a non-negative integer`);
  }
}

/** Pushes a problem naming `path` unless `value` is absent or parseable as ISO 8601. */
function checkOptionalIso(problems, value, path) {
  if (value !== undefined && !isIsoString(value)) {
    problems.push(`${path} must be an ISO 8601 date string`);
  }
}

/**
 * Validates an observation and returns every problem found as a string
 * naming the offending field path (e.g. "price.promoCents must be a
 * non-negative integer"). An empty array means valid. Never throws,
 * even on malformed input.
 */
export function validateObservation(observation) {
  const problems = [];

  if (!observation || typeof observation !== "object") {
    return ["observation must be an object"];
  }

  const { product, store, price, source, observedAt, promotion } = observation;

  if (!product || typeof product !== "object") {
    problems.push("product must be an object");
  } else {
    requireNonEmptyString(problems, product.id, "product.id");
  }

  if (!store || typeof store !== "object") {
    problems.push("store must be an object");
  } else {
    requireNonEmptyString(problems, store.id, "store.id");
    requireNonEmptyString(problems, store.retailer, "store.retailer");
  }

  if (!isIsoString(observedAt)) {
    problems.push("observedAt must be an ISO 8601 date string");
  }

  if (!price || typeof price !== "object") {
    problems.push("price must be an object");
  } else {
    if (!isNonNegativeInteger(price.regularCents)) {
      problems.push("price.regularCents must be a non-negative integer");
    }
    checkOptionalCents(problems, price.promoCents, "price.promoCents");
    checkOptionalCents(problems, price.memberCents, "price.memberCents");
  }

  if (!source || typeof source !== "object") {
    problems.push("source must be an object");
  } else {
    requireNonEmptyString(problems, source.retailerProductId, "source.retailerProductId");
  }

  if (promotion !== undefined) {
    if (!promotion || typeof promotion !== "object") {
      problems.push("promotion must be an object when present");
    } else {
      checkOptionalIso(problems, promotion.startsAt, "promotion.startsAt");
      checkOptionalIso(problems, promotion.endsAt, "promotion.endsAt");
      if (
        promotion.savePercent !== undefined &&
        !(typeof promotion.savePercent === "number" && Number.isFinite(promotion.savePercent))
      ) {
        problems.push("promotion.savePercent must be a finite number");
      }
    }
  }

  return problems;
}

/**
 * Parses an observation, throwing a TypeError naming every problem
 * (joined by "; ") so malformed data fails loudly at collection time.
 * Returns the observation unchanged when valid.
 */
export function parseObservation(observation) {
  const problems = validateObservation(observation);
  if (problems.length > 0) {
    throw new TypeError(`Invalid observation: ${problems.join("; ")}`);
  }
  return observation;
}
