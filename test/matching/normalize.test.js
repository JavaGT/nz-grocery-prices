import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeGTIN,
  normalizeBrand,
  normalizeName,
  tokenizeName,
  STOP_WORDS,
} from '../../src/matching/normalize.js';

describe('normalizeGTIN', () => {
  it('normalizes a standard 13-digit GTIN', () => {
    assert.equal(normalizeGTIN(' 9412345678901 '), '9412345678901');
  });

  it('normalizes a 12-digit UPC', () => {
    assert.equal(normalizeGTIN('123456789012'), '123456789012');
  });

  it('preserves leading zeros', () => {
    assert.equal(normalizeGTIN('00123456789012'), '00123456789012');
  });

  it('rejects null/undefined', () => {
    assert.equal(normalizeGTIN(null), null);
    assert.equal(normalizeGTIN(undefined), null);
  });

  it('rejects whitespace-only', () => {
    assert.equal(normalizeGTIN('   '), null);
  });

  it('rejects non-digit characters', () => {
    assert.equal(normalizeGTIN('94ABC5678901'), null);
  });

  it('rejects strings shorter than 8 digits', () => {
    assert.equal(normalizeGTIN('1234567'), null);
  });

  it('rejects strings longer than 14 digits', () => {
    assert.equal(normalizeGTIN('123456789012345'), null);
  });

  it('accepts 8-digit GTIN', () => {
    assert.equal(normalizeGTIN('12345678'), '12345678');
  });

  it('rejects GTIN with internal spaces', () => {
    assert.equal(normalizeGTIN('941 2345 6789 01'), '9412345678901');
  });

  it('strips internal spaces for valid digit check', () => {
    const result = normalizeGTIN(' 94 123 456 7890 1 ');
    assert.equal(result, '9412345678901');
  });
});

describe('normalizeBrand', () => {
  it('lowercases and trims brand', () => {
    assert.equal(normalizeBrand('  Anchor '), 'anchor');
  });

  it('collapses multiple spaces', () => {
    assert.equal(normalizeBrand("  Goodman  Fielder "), 'goodman fielder');
  });

  it('returns null for null/undefined', () => {
    assert.equal(normalizeBrand(null), null);
    assert.equal(normalizeBrand(undefined), null);
  });
});

describe('normalizeName', () => {
  it('lowercases and trims', () => {
    assert.equal(normalizeName('  Anchor Blue Milk '), 'anchor blue milk');
  });
});

describe('tokenizeName', () => {
  it('splits name into tokens excluding stop words', () => {
    const tokens = tokenizeName('Anchor Blue Milk 1 Litre');
    assert.ok(tokens.includes('anchor'));
    assert.ok(tokens.includes('blue'));
    assert.ok(tokens.includes('milk'));
    assert.ok(tokens.includes('litre'));
    assert.equal(tokens.includes('1'), false);
  });

  it('excludes common stop words', () => {
    const tokens = tokenizeName('The Best of Milk');
    assert.equal(tokens.includes('the'), false);
    assert.equal(tokens.includes('best'), true);
    assert.equal(tokens.includes('of'), false);
    assert.equal(tokens.includes('milk'), true);
  });

  it('returns empty array for empty/null input', () => {
    assert.deepEqual(tokenizeName(null), []);
    assert.deepEqual(tokenizeName(''), []);
  });

  it('strips punctuation', () => {
    const tokens = tokenizeName("Blue's Milk - Fresh!");
    assert.ok(tokens.includes("blue's"));
    assert.ok(tokens.includes('milk'));
    assert.ok(tokens.includes('fresh'));
  });

  it('filters single-character tokens', () => {
    const tokens = tokenizeName('Milk X Y Z Ultra');
    assert.ok(tokens.includes('milk'));
    assert.ok(tokens.includes('ultra'));
    assert.equal(tokens.includes('x'), false);
    assert.equal(tokens.includes('y'), false);
    assert.equal(tokens.includes('z'), false);
  });
});
