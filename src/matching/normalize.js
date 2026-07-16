export const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with',
  'is', 'it', 'by', '&',
]);

export function normalizeGTIN(gtin) {
  if (gtin == null) return null;
  const cleaned = String(gtin).replace(/\s+/g, '');
  if (!/^\d+$/.test(cleaned)) return null;
  if (cleaned.length < 8 || cleaned.length > 14) return null;
  return cleaned;
}

export function normalizeBrand(brand) {
  if (!brand) return null;
  return brand.toLowerCase().trim().replace(/\s+/g, ' ');
}

export function normalizeName(name) {
  if (!name) return null;
  return name.toLowerCase().trim().replace(/\s+/g, ' ');
}

export function tokenizeName(name) {
  if (!name) return [];
  const normalized = normalizeName(name);
  if (!normalized) return [];
  return normalized
    .replace(/[^\w\s']/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1)
    .filter(t => !STOP_WORDS.has(t));
}
