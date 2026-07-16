import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  jaccardSimilarity,
  parseQuantity,
  computeFuzzyScore,
  DEFAULT_FUZZY_THRESHOLD,
} from '../../src/matching/fuzz.js';

describe('jaccardSimilarity', () => {
  it('returns 1 for identical token sets', () => {
    assert.equal(jaccardSimilarity(['a', 'b', 'c'], ['a', 'b', 'c']), 1);
  });

  it('returns 0 for disjoint token sets', () => {
    assert.equal(jaccardSimilarity(['a', 'b'], ['c', 'd']), 0);
  });

  it('returns 1/3 for one-of-three overlap', () => {
    assert.equal(jaccardSimilarity(['a', 'b'], ['b', 'c']), 1 / 3);
  });

  it('returns 0 for both empty', () => {
    assert.equal(jaccardSimilarity([], []), 0);
  });

  it('is symmetric', () => {
    const r1 = jaccardSimilarity(['a', 'b', 'c'], ['b', 'c', 'd']);
    const r2 = jaccardSimilarity(['b', 'c', 'd'], ['a', 'b', 'c']);
    assert.equal(r1, r2);
  });
});

describe('parseQuantity', () => {
  it('parses kg', () => {
    assert.deepEqual(parseQuantity('1kg'), { value: 1, unit: 'kg' });
    assert.deepEqual(parseQuantity('1.5 kg'), { value: 1.5, unit: 'kg' });
  });

  it('parses g', () => {
    assert.deepEqual(parseQuantity('500g'), { value: 500, unit: 'g' });
  });

  it('parses L', () => {
    assert.deepEqual(parseQuantity('2L'), { value: 2, unit: 'l' });
    assert.deepEqual(parseQuantity('2 L'), { value: 2, unit: 'l' });
  });

  it('normalises lt to l', () => {
    assert.deepEqual(parseQuantity('2lt'), { value: 2, unit: 'l' });
  });

  it('parses ml', () => {
    assert.deepEqual(parseQuantity('750ml'), { value: 750, unit: 'ml' });
  });

  it('returns null for unparseable strings', () => {
    assert.equal(parseQuantity(null), null);
    assert.equal(parseQuantity(''), null);
    assert.equal(parseQuantity('various'), null);
  });
});

describe('computeFuzzyScore', () => {
  function makeProduct(name, brand, size, tokens) {
    return { name, brand, size, _tokens: tokens || [] };
  }

  it('returns score >= threshold for high token overlap', () => {
    const a = makeProduct('Anchor Blue Milk 1L', 'Anchor', '1L', ['anchor', 'blue', 'milk', '1l']);
    const b = makeProduct('Anchor Blue Milk 2L', 'Anchor', '2L', ['anchor', 'blue', 'milk', '2l']);
    const { score, isCandidate } = computeFuzzyScore(a, b);
    assert.ok(score >= DEFAULT_FUZZY_THRESHOLD);
    assert.equal(isCandidate, true);
  });

  it('adds brand match bonus', () => {
    const a = makeProduct('Blue Milk', 'Anchor', null, ['blue', 'milk']);
    const b = makeProduct('Green Milk', 'Anchor', null, ['green', 'milk']);
    const result = computeFuzzyScore(a, b);
    assert.equal(result.breakdown.brandMatch > 0, true);
  });

  it('adds quantity match bonus when parsed values match', () => {
    const a = makeProduct('Milk', 'Anchor', '1L', ['milk']);
    const b = makeProduct('Milk', 'Brand', '1L', ['milk']);
    const result = computeFuzzyScore(a, b);
    assert.equal(result.breakdown.quantityMatch > 0, true);
  });

  it('returns isCandidate false for low overlap', () => {
    const a = makeProduct('Milk', 'A', null, ['milk']);
    const b = makeProduct('Bread', 'B', null, ['bread']);
    const { isCandidate } = computeFuzzyScore(a, b, { threshold: 0.5 });
    assert.equal(isCandidate, false);
  });

  it('caps score at 1.0', () => {
    const a = makeProduct('Anchor Blue Milk Fresh', 'Anchor', null, ['anchor', 'blue', 'milk', 'fresh']);
    const b = makeProduct('Anchor Blue Milk Fresh', 'Anchor', null, ['anchor', 'blue', 'milk', 'fresh']);
    const { score } = computeFuzzyScore(a, b);
    assert.ok(score <= 1.0);
  });
});
