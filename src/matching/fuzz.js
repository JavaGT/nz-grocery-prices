import { normalizeBrand } from './normalize.js';

export const DEFAULT_FUZZY_THRESHOLD = 0.4;
export const BRAND_MATCH_BONUS = 0.15;
export const QUANTITY_MATCH_BONUS = 0.1;

export function jaccardSimilarity(tokensA, tokensB) {
  if (tokensA.length === 0 && tokensB.length === 0) return 0;
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  let intersection = 0;
  for (const t of setB) {
    if (setA.has(t)) intersection++;
  }
  const unionSize = new Set([...tokensA, ...tokensB]).size;
  return unionSize === 0 ? 0 : intersection / unionSize;
}

export function parseQuantity(size) {
  if (!size) return null;
  const cleaned = String(size).trim();
  const m = cleaned.match(/^(\d+(?:\.\d+)?)\s*(g|kg|ml|l|lt|each|pack|count|dozen|ea)$/i);
  if (!m) return null;
  const value = parseFloat(m[1]);
  let unit = m[2].toLowerCase();
  if (unit === 'lt') unit = 'l';
  return { value, unit };
}

export function computeFuzzyScore(productA, productB, options = {}) {
  const threshold = options.threshold ?? DEFAULT_FUZZY_THRESHOLD;

  const tokensA = productA._tokens || [];
  const tokensB = productB._tokens || [];
  const tokenScore = jaccardSimilarity(tokensA, tokensB);

  const breakdown = { tokenSimilarity: tokenScore, brandMatch: 0, quantityMatch: 0 };
  let total = tokenScore;

  if (productA.brand && productB.brand &&
      normalizeBrand(productA.brand) === normalizeBrand(productB.brand)) {
    breakdown.brandMatch = BRAND_MATCH_BONUS;
    total += BRAND_MATCH_BONUS;
  }

  const qtyA = parseQuantity(productA.size);
  const qtyB = parseQuantity(productB.size);
  if (qtyA && qtyB && qtyA.value === qtyB.value && qtyA.unit === qtyB.unit) {
    breakdown.quantityMatch = QUANTITY_MATCH_BONUS;
    total += QUANTITY_MATCH_BONUS;
  }

  return { score: Math.min(total, 1), breakdown, isCandidate: total >= threshold };
}
