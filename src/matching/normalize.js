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

const NAME_PUNCTUATION_RE = /[^\w\s']/g;
const WHITESPACE_RE = /\s+/;

export function tokenizeName(name) {
  if (!name) return [];
  const normalized = normalizeName(name);
  if (!normalized) return [];
  const parts = normalized.replace(NAME_PUNCTUATION_RE, ' ').split(WHITESPACE_RE);
  const tokens = [];
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i];
    if (t.length > 1 && !STOP_WORDS.has(t)) tokens.push(t);
  }
  return tokens;
}
