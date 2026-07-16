import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findGtinMatches,
  findSourceIdMatches,
  findFuzzyCandidates,
  canonicalPair,
  evidenceHashForGtin,
  evidenceHashForSourceId,
  evidenceHashForFuzzy,
  FUZZY_BRAND_GROUP_MAX_SIZE,
} from '../../src/matching/matcher.js';

function product(overrides = {}) {
  return {
    id: 'retailer:1',
    retailer_id: 'paknsave',
    name: 'Product',
    brand: 'TestBrand',
    category: 'Dairy',
    size: '1L',
    source_id: null,
    gtin: null,
    ...overrides,
  };
}

describe('canonicalPair', () => {
  it('orders pairs lexicographically', () => {
    assert.deepEqual(canonicalPair('b:1', 'a:1'), ['a:1', 'b:1']);
    assert.deepEqual(canonicalPair('a:1', 'b:1'), ['a:1', 'b:1']);
  });
});

describe('findGtinMatches', () => {
  it('finds exact GTIN match across retailers', () => {
    const products = [
      product({ id: 'paknsave:1', gtin: '9412345678901', retailer_id: 'paknsave' }),
      product({ id: 'newworld:1', gtin: '9412345678901', retailer_id: 'newworld' }),
    ];
    const matches = findGtinMatches(products);
    assert.equal(matches.length, 1);
    const m = matches[0];
    assert.equal(m.matchMethod, 'auto_gtin');
    assert.equal(m.reviewState, 'confirmed');
    assert.equal(m.confidence, 1.0);
  });

  it('does not match different GTINs', () => {
    const products = [
      product({ id: 'paknsave:1', gtin: '9412345678901', retailer_id: 'paknsave' }),
      product({ id: 'newworld:1', gtin: '9412345678902', retailer_id: 'newworld' }),
    ];
    assert.equal(findGtinMatches(products).length, 0);
  });

  it('produces 3 pairs for 3 products with same GTIN', () => {
    const products = [
      product({ id: 'a:1', gtin: '123456789012', retailer_id: 'paknsave' }),
      product({ id: 'b:2', gtin: '123456789012', retailer_id: 'newworld' }),
      product({ id: 'c:3', gtin: '123456789012', retailer_id: 'woolworths' }),
    ];
    assert.equal(findGtinMatches(products).length, 3);
  });

  it('distinguishes GTINs with leading zeros', () => {
    const products = [
      product({ id: 'a:1', gtin: '0012345678901', retailer_id: 'paknsave' }),
      product({ id: 'b:2', gtin: '0123456789010', retailer_id: 'newworld' }),
    ];
    assert.equal(findGtinMatches(products).length, 0);
  });

  it('ignores products without GTIN', () => {
    const products = [
      product({ id: 'a:1', gtin: null, retailer_id: 'paknsave' }),
      product({ id: 'b:2', gtin: undefined, retailer_id: 'newworld' }),
    ];
    assert.equal(findGtinMatches(products).length, 0);
  });

  it('rejects invalid GTIN characters', () => {
    const products = [
      product({ id: 'a:1', gtin: '94ABC5678901', retailer_id: 'paknsave' }),
      product({ id: 'b:2', gtin: '94ABC5678901', retailer_id: 'newworld' }),
    ];
    assert.equal(findGtinMatches(products).length, 0);
  });

  it('matches same GTIN across same retailer (same GTIN different IDs)', () => {
    const products = [
      product({ id: 'paknsave:1', gtin: '9410000000000', retailer_id: 'paknsave' }),
      product({ id: 'paknsave:2', gtin: '9410000000000', retailer_id: 'paknsave' }),
    ];
    assert.equal(findGtinMatches(products).length, 1);
  });
});

describe('findSourceIdMatches', () => {
  it('matches paknsave ↔ newworld with same source_id', () => {
    const products = [
      product({ id: 'paknsave:1', source_id: 'FS123', retailer_id: 'paknsave' }),
      product({ id: 'newworld:1', source_id: 'FS123', retailer_id: 'newworld' }),
    ];
    const matches = findSourceIdMatches(products);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].matchMethod, 'auto_source_id');
    assert.equal(matches[0].reviewState, 'confirmed');
  });

  it('does not match same-retailer source_id duplicates', () => {
    const products = [
      product({ id: 'paknsave:1', source_id: 'FS123', retailer_id: 'paknsave' }),
      product({ id: 'paknsave:2', source_id: 'FS123', retailer_id: 'paknsave' }),
    ];
    assert.equal(findSourceIdMatches(products).length, 0);
  });

  it('does not match if only one retailer is present', () => {
    const products = [
      product({ id: 'paknsave:1', source_id: 'FS123', retailer_id: 'paknsave' }),
    ];
    assert.equal(findSourceIdMatches(products).length, 0);
  });

  it('does not match non-Foodstuffs retailers', () => {
    const products = [
      product({ id: 'woolworths:1', source_id: 'FS123', retailer_id: 'woolworths' }),
      product({ id: 'freshchoice:1', source_id: 'FS123', retailer_id: 'freshchoice' }),
    ];
    assert.equal(findSourceIdMatches(products).length, 0);
  });

  it('ignores products without source_id', () => {
    const products = [
      product({ id: 'paknsave:1', source_id: null, retailer_id: 'paknsave' }),
      product({ id: 'newworld:1', source_id: null, retailer_id: 'newworld' }),
    ];
    assert.equal(findSourceIdMatches(products).length, 0);
  });

  it('generates cross pairs for many products sharing source_id', () => {
    const products = [
      product({ id: 'paknsave:a', source_id: 'FS999', retailer_id: 'paknsave' }),
      product({ id: 'paknsave:b', source_id: 'FS999', retailer_id: 'paknsave' }),
      product({ id: 'newworld:x', source_id: 'FS999', retailer_id: 'newworld' }),
      product({ id: 'newworld:y', source_id: 'FS999', retailer_id: 'newworld' }),
    ];
    const matches = findSourceIdMatches(products);
    assert.ok(matches.length >= 4);
    for (const m of matches) {
      assert.equal(m.matchMethod, 'auto_source_id');
    }
  });
});

describe('findFuzzyCandidates', () => {
  it('generates candidates for products with same brand and similar names', () => {
    const products = [
      product({ id: 'paknsave:1', name: 'Anchor Blue Milk', brand: 'Anchor', retailer_id: 'paknsave' }),
      product({ id: 'newworld:1', name: 'Anchor Blue Milk', brand: 'Anchor', retailer_id: 'newworld' }),
    ];
    const candidates = findFuzzyCandidates(products);
    assert.ok(candidates.length > 0);
    assert.equal(candidates[0].matchMethod, 'fuzzy_candidate');
    assert.equal(candidates[0].reviewState, 'candidate');
  });

  it('does not generate candidates for lookalike names with different brand', () => {
    const products = [
      product({ id: 'paknsave:1', name: 'Signature Range Milk', brand: 'Pams', retailer_id: 'paknsave' }),
      product({ id: 'newworld:1', name: 'Value Milk', brand: 'Home Brand', retailer_id: 'newworld' }),
    ];
    const candidates = findFuzzyCandidates(products, { threshold: 0.6 });
    assert.equal(candidates.length, 0);
  });

  it('skips oversized brand groups', () => {
    const products = [];
    for (let i = 0; i < FUZZY_BRAND_GROUP_MAX_SIZE + 5; i++) {
      products.push(product({
        id: `retailer:${i}`,
        name: `Generic Product ${i}`,
        brand: 'OverflowBrand',
        retailer_id: 'paknsave',
      }));
    }
    const candidates = findFuzzyCandidates(products);
    assert.equal(candidates.length, 0);
  });

  it('respects threshold option', () => {
    const products = [
      product({ id: 'a:1', name: 'Fresh Milk Whole', brand: 'A', retailer_id: 'paknsave' }),
      product({ id: 'b:2', name: 'Trim Milk Lite', brand: 'B', retailer_id: 'newworld' }),
    ];
    const low = findFuzzyCandidates(products, { threshold: 0.1 });
    const high = findFuzzyCandidates(products, { threshold: 0.9 });
    assert.ok(low.length >= high.length);
  });

  it('respects batchCap', () => {
    const products = [];
    for (let i = 0; i < 30; i++) {
      const brand = i < 15 ? 'BrandA' : 'BrandB';
      products.push(product({
        id: `r:${i}`,
        name: `Product ${i} Special Item`,
        brand,
        retailer_id: 'paknsave',
      }));
    }
    const capped = findFuzzyCandidates(products, { batchCap: 5 });
    assert.ok(capped.length <= 5);
  });

  it('assigns deterministic evidence hash', () => {
    const products = [
      product({ id: 'a:1', name: 'Anchor Milk', brand: 'Anchor', size: '1L', retailer_id: 'paknsave' }),
      product({ id: 'b:2', name: 'Anchor Milk', brand: 'Anchor', size: '1L', retailer_id: 'newworld' }),
    ];
    const r1 = findFuzzyCandidates(products);
    const r2 = findFuzzyCandidates(products);
    assert.equal(r1.length, r2.length);
    if (r1.length > 0) {
      assert.equal(r1[0].evidenceHash, r2[0].evidenceHash);
    }
  });

  it('produces scoreBreakdown on each candidate', () => {
    const products = [
      product({ id: 'a:1', name: 'Anchor Blue Milk', brand: 'Anchor', size: '1L', retailer_id: 'paknsave' }),
      product({ id: 'b:2', name: 'Anchor Standard Milk', brand: 'Anchor', size: '1L', retailer_id: 'newworld' }),
    ];
    const candidates = findFuzzyCandidates(products);
    if (candidates.length > 0) {
      const c = candidates[0];
      assert.ok(c.scoreBreakdown);
      assert.ok('tokenSimilarity' in c.scoreBreakdown);
      assert.ok('brandMatch' in c.scoreBreakdown);
      assert.ok('quantityMatch' in c.scoreBreakdown);
    }
  });
});
