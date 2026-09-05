/**
 * Shared observation building for the retailers/ campaign adapters.
 *
 * Every campaign adapter turns its retailer payload into the canonical
 * PriceObservation (see src/domain/observation.js) through buildObservation
 * so identity, price, and promotion derivation have exactly one source.
 * Tests validate emitted observations with parseObservation.
 */

/** nz-handy: is `value` a finite number. */
function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Parse a display price into integer cents. Accepts numbers (3.5), dollar
 * strings ("$3.50", "1,299.00"), or already-scaled integers (350). Returns
 * undefined when the value cannot be interpreted.
 */
export function toCents(value) {
  if (isFiniteNumber(value)) return Math.round(value * 100);
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[$\s,]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return undefined;
  return Math.round(Number(cleaned) * 100);
}

/**
 * Convert a store-API minor-unit price ("2900" with minorUnit 2) into
 * integer cents. WooCommerce's Store API is the main user. Returns
 * undefined for junk.
 */
export function minorUnitsToCents(value, minorUnit = 2) {
  const scale = Number(minorUnit);
  if (!Number.isInteger(scale) || scale < 0 || scale > 4) return undefined;
  const number = typeof value === "string" ? Number(value) : value;
  if (!isFiniteNumber(number) || !Number.isInteger(number)) return undefined;
  return Math.round(number * 10 ** (2 - scale));
}

function asNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Derive the promotion block from a regular-vs-current price pair. Returns
 * undefined when there is no genuine discount (current >= regular).
 */
export function promotionFor({
  regularCents,
  currentCents,
  type = "SPECIAL",
  description,
  startsAt,
  endsAt,
  memberOnly = false,
}) {
  if (!Number.isInteger(regularCents) || !Number.isInteger(currentCents)) return undefined;
  if (currentCents >= regularCents) return undefined;
  return {
    type,
    memberOnly,
    saveCents: regularCents - currentCents,
    savePercent: Math.round(((regularCents - currentCents) / regularCents) * 10_000) / 100,
    ...(description ? { description } : {}),
    ...(startsAt ? { startsAt } : {}),
    ...(endsAt ? { endsAt } : {}),
  };
}

/**
 * Build one canonical PriceObservation, or undefined when required fields
 * (name, retailerProductId, regularCents) are missing so callers can
 * `filter(Boolean)` malformed payloads away uniformly.
 *
 * spec: {
 *   slug, storeId, storeName, region?, origin?,
 *   retailerProductId, url, name,
 *   brand?, gtin?, categories?, image?,
 *   regularCents, promoCents?, memberCents?,
 *   promotion? (overrides the derived block), observedAt?,
 * }
 */
export function buildObservation(spec) {
  const slug = asNonEmptyString(spec.slug);
  const name = asNonEmptyString(spec.name);
  const retailerProductId = asNonEmptyString(spec.retailerProductId);
  const storeId = asNonEmptyString(spec.storeId);
  const regularCents = spec.regularCents;
  if (!slug || !name || !retailerProductId || !storeId) return undefined;
  if (!Number.isInteger(regularCents) || regularCents < 0) return undefined;

  const promoCents = Number.isInteger(spec.promoCents) ? spec.promoCents : undefined;
  const memberCents = Number.isInteger(spec.memberCents) ? spec.memberCents : undefined;
  const effectiveCents = promoCents ?? memberCents ?? regularCents;
  const promotion = spec.promotion !== undefined
    ? spec.promotion
    : promoCents !== undefined
      ? promotionFor({ regularCents, currentCents: promoCents })
      : undefined;

  const categories = Array.isArray(spec.categories)
    ? spec.categories.map(asNonEmptyString).filter(Boolean)
    : undefined;

  return {
    product: {
      id: `${slug}:${retailerProductId}`,
      name,
      ...(spec.brand ? { brand: asNonEmptyString(spec.brand) } : {}),
      ...(spec.gtin ? { gtin: asNonEmptyString(spec.gtin) } : {}),
      ...(categories?.length ? { categories } : {}),
      ...(spec.image ? { images: { primary: spec.image } } : {}),
    },
    store: {
      id: `${slug}:${storeId}`,
      retailer: slug,
      name: spec.storeName ?? slug,
      ...(spec.region ? { region: spec.region } : {}),
      ...(spec.origin ? { origin: spec.origin } : {}),
    },
    price: {
      currency: "NZD",
      regularCents,
      ...(promoCents !== undefined ? { promoCents } : {}),
      ...(memberCents !== undefined ? { memberCents } : {}),
    },
    ...(promotion ? { promotion } : {}),
    observedAt: spec.observedAt ?? new Date().toISOString(),
    source: {
      retailerProductId,
      adapter: slug,
      ...(spec.url ? { url: spec.url } : {}),
    },
  };
}
