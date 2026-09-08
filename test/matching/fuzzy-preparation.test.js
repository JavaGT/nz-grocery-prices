import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  findFuzzyCandidates,
  prepareProductsForFuzzy,
  prepareProductForFuzzy,
  evidenceHashForFuzzy,
} from '../../src/matching/matcher.js';
import { tokenizeName } from '../../src/matching/normalize.js';

function product(overrides = {}) {
  return {
    id: 'paknsave:1',
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

describe('lazy fuzzy preparation equivalence', () => {
  it('candidates carry the precomputed fields of the prepared product', () => {
    const products = [
      product({ id: 'a:1', name: 'Anchor Blue Milk', brand: 'Anchor' }),
      product({ id: 'b:2', name: 'Anchor Blue Milk', brand: 'anchor ' }),
    ];
    const candidates = findFuzzyCandidates(products);
    assert.ok(candidates.length > 0);
    const c = candidates[0];
    assert.equal(c.productA._tokens.length, 3);
    assert.equal(c.productA._normalizedBrand, 'anchor');
    assert.equal(c.productB._normalizedBrand, 'anchor');
    // non-precomputed product fields survive the preparation copy
    assert.equal(c.productA.retailer_id, 'paknsave');
    assert.equal(c.productB.name, 'Anchor Blue Milk');
  });

  it('groups products without a brand under __no_brand__ and still scores them', () => {
    const products = [
      product({ id: 'a:1', name: 'Fresh Whole Milk', brand: null }),
      product({ id: 'b:2', name: 'Fresh Whole Milk', brand: null }),
    ];
    const candidates = findFuzzyCandidates(products);
    assert.ok(candidates.length > 0);
    assert.deepEqual(
      candidates.map(c => [c.productAId, c.productBId]),
      [['a:1', 'b:2']],
    );
  });

  it('produces identical evidence hashes as hashing the prepared pair directly', () => {
    const products = [
      product({ id: 'a:1', name: 'Anchor Trim Milk 1L', brand: 'Anchor', size: '1L' }),
      product({ id: 'b:2', name: 'Anchor Trim Milk', brand: 'Anchor', size: '1L' }),
    ];
    const candidates = findFuzzyCandidates(products);
    assert.ok(candidates.length > 0);
    const prepared = prepareProductsForFuzzy(products);
    assert.equal(
      candidates[0].evidenceHash,
      evidenceHashForFuzzy(prepared[0], prepared[1]),
    );
  });

  it('prepareProductForFuzzy does not mutate the input product', () => {
    const p = product({ name: 'Anchor Milk' });
    const prepared = prepareProductForFuzzy(p);
    assert.equal(p._tokens, undefined);
    assert.deepEqual(prepared._tokens, tokenizeName('Anchor Milk'));
  });
});
