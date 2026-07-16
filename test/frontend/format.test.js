import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

function formatCents(cents) {
  if (cents == null) return '';
  return '$' + (cents / 100).toFixed(2);
}

function formatDropPercent(current, regular) {
  if (regular == null || regular <= 0 || current == null) return null;
  return Math.round((1 - current / regular) * 100);
}

function freshnessLevel(observedAt) {
  if (!observedAt) return 'none';
  const age = Date.now() - (typeof observedAt === 'number' ? observedAt : new Date(observedAt).getTime());
  const days = age / 86400000;
  if (days <= 7) return 'fresh';
  if (days <= 14) return 'stale';
  return 'old';
}

function retailerColor(retailer) {
  const map = {
    paknsave: '#125b39',
    newworld: '#d71920',
    woolworths: '#0b55a2',
    freshchoice: '#6b21a8',
    warehouse: '#ec2334',
  };
  return map[retailer] || '#637168';
}

function retailerLabel(retailer) {
  const map = {
    paknsave: "PAK'nSAVE",
    newworld: 'New World',
    woolworths: 'Woolworths',
    freshchoice: 'FreshChoice',
    warehouse: 'The Warehouse',
  };
  return map[retailer] || retailer;
}

describe('formatCents', () => {
  it('formats 0 as $0.00', () => {
    assert.equal(formatCents(0), '$0.00');
  });
  it('formats 479 as $4.79', () => {
    assert.equal(formatCents(479), '$4.79');
  });
  it('formats 1000 as $10.00', () => {
    assert.equal(formatCents(1000), '$10.00');
  });
  it('formats 9999 as $99.99', () => {
    assert.equal(formatCents(9999), '$99.99');
  });
  it('returns empty string for null', () => {
    assert.equal(formatCents(null), '');
  });
  it('returns empty string for undefined', () => {
    assert.equal(formatCents(undefined), '');
  });
});

describe('formatDropPercent', () => {
  it('returns 24 for 479/629', () => {
    assert.equal(formatDropPercent(479, 629), 24);
  });
  it('returns 46 for 299/549', () => {
    assert.equal(formatDropPercent(299, 549), 46);
  });
  it('returns null when regular is 0', () => {
    assert.equal(formatDropPercent(100, 0), null);
  });
  it('returns null when regular is null', () => {
    assert.equal(formatDropPercent(100, null), null);
  });
  it('returns 0 for equal prices', () => {
    assert.equal(formatDropPercent(500, 500), 0);
  });
  it('returns negative when current > regular', () => {
    assert.equal(formatDropPercent(600, 500), -20);
  });
});

describe('freshnessLevel', () => {
  const now = Date.now();
  const HOUR = 3600000;
  const DAY = 86400000;

  it('returns "fresh" for data < 7 days old', () => {
    const age = now - (3 * DAY);
    assert.equal(freshnessLevel(age), 'fresh');
  });
  it('returns "fresh" for just under 7 days', () => {
    const age = now - (6 * DAY + 23 * HOUR);
    assert.equal(freshnessLevel(age), 'fresh');
  });
  it('returns "stale" for > 7 days', () => {
    const age = now - (8 * DAY);
    assert.equal(freshnessLevel(age), 'stale');
  });
  it('returns "stale" for 13 days', () => {
    const age = now - (13 * DAY);
    assert.equal(freshnessLevel(age), 'stale');
  });
  it('returns "old" for > 14 days', () => {
    const age = now - (20 * DAY);
    assert.equal(freshnessLevel(age), 'old');
  });
  it('returns "fresh" for recent hours', () => {
    const age = now - (5 * HOUR);
    assert.equal(freshnessLevel(age), 'fresh');
  });
  it('accepts ISO string', () => {
    const d = new Date(now - (2 * DAY)).toISOString();
    assert.equal(freshnessLevel(d), 'fresh');
  });
  it('returns "none" for null', () => {
    assert.equal(freshnessLevel(null), 'none');
  });
  it('returns "none" for undefined', () => {
    assert.equal(freshnessLevel(undefined), 'none');
  });
});

describe('retailerColor', () => {
  it('returns paknsave green', () => {
    assert.equal(retailerColor('paknsave'), '#125b39');
  });
  it('returns newworld red', () => {
    assert.equal(retailerColor('newworld'), '#d71920');
  });
  it('returns woolworths blue', () => {
    assert.equal(retailerColor('woolworths'), '#0b55a2');
  });
  it('returns fallback for unknown', () => {
    assert.equal(retailerColor('unknown'), '#637168');
  });
});

describe('retailerLabel', () => {
  it('returns "PAK\'nSAVE" for paknsave', () => {
    assert.equal(retailerLabel('paknsave'), "PAK'nSAVE");
  });
  it('returns fallback for unknown', () => {
    assert.equal(retailerLabel('unknown'), 'unknown');
  });
});
