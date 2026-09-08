import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MatchingOrchestrator } from '../../src/matching/orchestrator.js';

function product(overrides = {}) {
  return {
    id: 'paknsave:1',
    retailer_id: 'paknsave',
    name: 'Product',
    brand: 'Brand',
    category: 'Grocery',
    size: null,
    source_id: null,
    gtin: null,
    ...overrides,
  };
}

// Minimal in-memory app-db double: no runInTransaction, exercising the
// orchestrator's fallback path for injectable dependencies.
function makeInMemoryDb() {
  const rows = new Map();
  let nextId = 1;
  return {
    createMatchPair(input) {
      const key = [input.productAId, input.productBId].sort().join('\u0000');
      rows.set(key, { ...input, id: nextId++ });
      return rows.get(key).id;
    },
    getMatchPair(aId, bId) {
      return rows.get([aId, bId].sort().join('\u0000')) || null;
    },
    updateMatchPair(id, changes) {
      for (const row of rows.values()) {
        if (row.id === id) Object.assign(row, changes);
      }
    },
    rows,
  };
}

describe('MatchingOrchestrator persistence seams', () => {
  it('falls back to direct writes when the app db has no runInTransaction', () => {
    const db = makeInMemoryDb();
    const products = [
      product({ id: 'a:1', gtin: '12345678', retailer_id: 'paknsave' }),
      product({ id: 'b:2', gtin: '12345678', retailer_id: 'newworld' }),
    ];
    const result = new MatchingOrchestrator(db, products).runAutoMatches();
    assert.equal(result.inserted, 1);
    assert.equal(result.errors.length, 0);
    assert.equal(db.rows.size, 1);
  });

  it('keeps counting later pairs when one pair write fails inside a transaction', () => {
    const db = makeInMemoryDb();
    const products = [
      product({ id: 'a:1', gtin: '12345678', retailer_id: 'paknsave' }),
      product({ id: 'b:2', gtin: '12345678', retailer_id: 'newworld' }),
      product({ id: 'c:3', gtin: '87654321', retailer_id: 'paknsave' }),
      product({ id: 'd:4', gtin: '87654321', retailer_id: 'newworld' }),
    ];
    const orchestrator = new MatchingOrchestrator(db, products);
    // first pair write is injected to fail, proving the loop continues
    const originalCreate = db.createMatchPair.bind(db);
    let transactional = false;
    db.runInTransaction = fn => {
      transactional = true;
      return fn();
    };
    db.createMatchPair = input => {
      const key = [input.productAId, input.productBId].sort().join('\u0000');
      if (key === 'a:1\u0000b:2') throw new Error('injected failure');
      return originalCreate(input);
    };

    const result = orchestrator.runAutoMatches();
    assert.equal(transactional, true, 'batch ran inside runInTransaction');
    assert.equal(result.inserted, 1);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error, /injected failure/);
    assert.equal(result.errors[0].pair, 'a:1↔b:2');
    assert.equal(db.rows.size, 1);
  });
});
