import { createHash } from 'node:crypto';
import { normalizeGTIN, tokenizeName, normalizeBrand } from './normalize.js';
import { computeFuzzyScore, DEFAULT_FUZZY_THRESHOLD } from './fuzz.js';

export const MATCHING_ALGORITHM_VERSION = '1.0.0';
export const FUZZY_BRAND_GROUP_MAX_SIZE = 20;
export const FUZZY_BATCH_CAP = 1000;

export function canonicalPair(idA, idB) {
  return idA < idB ? [idA, idB] : [idB, idA];
}

export function evidenceHashForGtin(productA, productB) {
  return createHash('sha256')
    .update(String(productA.gtin || ''))
    .update('\x00')
    .update(String(productB.gtin || ''))
    .digest('hex');
}

export function evidenceHashForSourceId(productA, productB) {
  return createHash('sha256')
    .update(String(productA.source_id || ''))
    .update('\x00')
    .update(String(productB.source_id || ''))
    .digest('hex');
}

export function evidenceHashForFuzzy(productA, productB) {
  return createHash('sha256')
    .update(String(productA.name || ''))
    .update('\x00')
    .update(String(productB.name || ''))
    .update('\x00')
    .update(String(productA.brand || ''))
    .update('\x00')
    .update(String(productB.brand || ''))
    .update('\x00')
    .update(String(productA.size || ''))
    .update('\x00')
    .update(String(productB.size || ''))
    .digest('hex');
}

export function findGtinMatches(products) {
  const byGtin = new Map();
  for (const p of products) {
    const normalized = normalizeGTIN(p.gtin);
    if (!normalized) continue;
    if (!byGtin.has(normalized)) byGtin.set(normalized, []);
    byGtin.get(normalized).push(p);
  }

  const matches = [];
  for (const [, group] of byGtin) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [aId, bId] = canonicalPair(group[i].id, group[j].id);
        matches.push({
          productAId: aId,
          productBId: bId,
          productA: group[i],
          productB: group[j],
          matchMethod: 'auto_gtin',
          confidence: 1.0,
          reviewState: 'confirmed',
          provenance: 'system',
          evidenceHash: evidenceHashForGtin(group[i], group[j]),
        });
      }
    }
  }
  return matches;
}

export function findSourceIdMatches(products) {
  const bySourceId = new Map();
  for (const p of products) {
    if (!p.source_id) continue;
    const rid = p.retailer_id;
    if (!rid || (rid !== 'paknsave' && rid !== 'newworld')) continue;
    if (!bySourceId.has(p.source_id)) bySourceId.set(p.source_id, []);
    bySourceId.get(p.source_id).push(p);
  }

  const matches = [];
  for (const [, group] of bySourceId) {
    if (group.length < 2) continue;
    const hasPaknsave = group.some(p => p.retailer_id === 'paknsave');
    const hasNewworld = group.some(p => p.retailer_id === 'newworld');
    if (!(hasPaknsave && hasNewworld)) continue;

    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const [aId, bId] = canonicalPair(group[i].id, group[j].id);
        matches.push({
          productAId: aId,
          productBId: bId,
          productA: group[i],
          productB: group[j],
          matchMethod: 'auto_source_id',
          confidence: 1.0,
          reviewState: 'confirmed',
          provenance: 'system',
          evidenceHash: evidenceHashForSourceId(group[i], group[j]),
        });
      }
    }
  }
  return matches;
}

export function prepareProductsForFuzzy(products) {
  return products.map(p => ({
    ...p,
    _tokens: tokenizeName(p.name),
    _normalizedBrand: normalizeBrand(p.brand),
  }));
}

export function findFuzzyCandidates(products, options = {}) {
  const prepared = prepareProductsForFuzzy(products);
  const threshold = options.threshold ?? DEFAULT_FUZZY_THRESHOLD;
  const brandMaxSize = options.brandGroupMaxSize ?? FUZZY_BRAND_GROUP_MAX_SIZE;
  const batchCap = options.batchCap ?? FUZZY_BATCH_CAP;

  const byBrand = new Map();
  for (const p of prepared) {
    const brand = p._normalizedBrand || '__no_brand__';
    if (!byBrand.has(brand)) byBrand.set(brand, []);
    byBrand.get(brand).push(p);
  }

  const candidates = [];

  for (const [, group] of byBrand) {
    if (group.length > brandMaxSize) continue;

    const scorable = group.filter(p => p._tokens.length > 0);

    for (let i = 0; i < scorable.length && candidates.length < batchCap; i++) {
      for (let j = i + 1; j < scorable.length && candidates.length < batchCap; j++) {
        const { score, breakdown, isCandidate } = computeFuzzyScore(
          scorable[i], scorable[j], { threshold },
        );

        if (!isCandidate) continue;

        const [aId, bId] = canonicalPair(scorable[i].id, scorable[j].id);
        candidates.push({
          productAId: aId,
          productBId: bId,
          productA: scorable[i],
          productB: scorable[j],
          matchMethod: 'fuzzy_candidate',
          confidence: score,
          reviewState: 'candidate',
          provenance: 'system',
          evidenceHash: evidenceHashForFuzzy(scorable[i], scorable[j]),
          scoreBreakdown: breakdown,
        });
      }
    }
  }

  return candidates;
}
