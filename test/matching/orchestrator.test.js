import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppDatabase } from '../../src/sqlite/app-db.js';
import { MatchingOrchestrator } from '../../src/matching/orchestrator.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'orch-test-'));
  const dbPath = join(dir, 'test.db');
  const appDb = new AppDatabase(dbPath);
  return { dir, appDb, dbPath };
}

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

describe('MatchingOrchestrator', () => {
  it('runAutoMatches persists GTIN matches to app DB', () => {
    const { appDb, dir } = setup();
    try {
      const products = [
        product({ id: 'paknsave:1', gtin: '9412345678901', retailer_id: 'paknsave' }),
        product({ id: 'newworld:1', gtin: '9412345678901', retailer_id: 'newworld' }),
      ];
      const orch = new MatchingOrchestrator(appDb, products);
      const result = orch.runAutoMatches();

      assert.equal(result.inserted, 1);
      assert.equal(result.skipped, 0);

      const pairs = appDb.getMatchPairs();
      assert.equal(pairs.length, 1);
      assert.equal(pairs[0].match_method, 'auto_gtin');
      assert.equal(pairs[0].review_state, 'confirmed');
      assert.equal(pairs[0].provenance, 'system');
    } finally {
      appDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runAutoMatches persists source_id matches to app DB', () => {
    const { appDb, dir } = setup();
    try {
      const products = [
        product({ id: 'paknsave:1', source_id: 'FS123', retailer_id: 'paknsave' }),
        product({ id: 'newworld:1', source_id: 'FS123', retailer_id: 'newworld' }),
      ];
      const orch = new MatchingOrchestrator(appDb, products);
      const result = orch.runAutoMatches();

      assert.equal(result.inserted, 1);
      const pairs = appDb.getMatchPairs();
      assert.equal(pairs[0].match_method, 'auto_source_id');
      assert.equal(pairs[0].review_state, 'confirmed');
    } finally {
      appDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runFuzzyCandidates persists candidates as review_state candidate', () => {
    const { appDb, dir } = setup();
    try {
      const products = [
        product({ id: 'paknsave:1', name: 'Fresh Whole Milk', brand: 'Anchor', retailer_id: 'paknsave' }),
        product({ id: 'newworld:1', name: 'Fresh Whole Milk', brand: 'Anchor', retailer_id: 'newworld' }),
      ];
      const orch = new MatchingOrchestrator(appDb, products);
      const result = orch.runFuzzyCandidates();

      assert.ok(result.inserted >= 1);
      const pairs = appDb.getMatchPairs({ states: ['candidate'] });
      assert.ok(pairs.length >= 1);
      assert.equal(pairs[0].match_method, 'fuzzy_candidate');
      assert.equal(pairs[0].review_state, 'candidate');
      assert.equal(pairs[0].provenance, 'system');
    } finally {
      appDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('is idempotent — second run skips with same evidence', () => {
    const { appDb, dir } = setup();
    try {
      const products = [
        product({ id: 'paknsave:1', gtin: '9412345678901', retailer_id: 'paknsave' }),
        product({ id: 'newworld:1', gtin: '9412345678901', retailer_id: 'newworld' }),
      ];
      const orch = new MatchingOrchestrator(appDb, products);
      const r1 = orch.runAutoMatches();
      const r2 = orch.runAutoMatches();

      assert.equal(r1.inserted, 1);
      assert.equal(r2.inserted, 0);
      assert.equal(r2.skipped, 1);
      assert.equal(appDb.getMatchPairs().length, 1);
    } finally {
      appDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not overwrite user-provenance matches', () => {
    const { appDb, dir } = setup();
    try {
      const products = [
        product({ id: 'paknsave:1', gtin: '9412345678901', retailer_id: 'paknsave' }),
        product({ id: 'newworld:1', gtin: '9412345678901', retailer_id: 'newworld' }),
      ];

      appDb.createMatchPair({
        productAId: 'newworld:1',
        productBId: 'paknsave:1',
        matchMethod: 'human_reviewed',
        algorithmVersion: '1.0.0',
        confidence: 1.0,
        reviewState: 'confirmed',
        provenance: 'user',
        inputEvidenceHash: null,
      });

      const orch = new MatchingOrchestrator(appDb, products);
      const result = orch.runAutoMatches();
      assert.equal(result.skipped, 1);
      assert.equal(result.inserted, 0);

      const pair = appDb.getMatchPair('paknsave:1', 'newworld:1');
      assert.equal(pair.provenance, 'user');
      assert.equal(pair.match_method, 'human_reviewed');
    } finally {
      appDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('suppresses rejected candidates with same evidence hash and algorithm version', () => {
    const { appDb, dir } = setup();
    try {
      const products = [
        product({ id: 'a:1', name: 'Fresh Milk', brand: 'Anchor', retailer_id: 'paknsave' }),
        product({ id: 'b:1', name: 'Fresh Milk', brand: 'Anchor', retailer_id: 'newworld' }),
      ];

      const orch = new MatchingOrchestrator(appDb, products);
      const r1 = orch.runFuzzyCandidates();
      assert.ok(r1.inserted >= 1);

      const pair = appDb.getMatchPairs()[0];
      appDb.updateMatchReview(pair.id, 'rejected', 'test-user');

      const r2 = orch.runFuzzyCandidates();
      assert.equal(r2.inserted, 0);
      assert.equal(r2.skipped, 1);
    } finally {
      appDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('user-rejected match is never overwritten even with updated evidence', () => {
    const { appDb, dir } = setup();
    try {
      const initial = [
        product({ id: 'a:1', name: 'Anchor Fresh Milk 1L', brand: 'Anchor', size: '1L', retailer_id: 'paknsave' }),
        product({ id: 'b:1', name: 'Anchor Milk 1L', brand: 'Anchor', size: '1L', retailer_id: 'newworld' }),
      ];
      const orch = new MatchingOrchestrator(appDb, initial);
      const r1 = orch.runFuzzyCandidates();
      assert.ok(r1.inserted >= 1);

      const pair = appDb.getMatchPairs()[0];
      appDb.updateMatchReview(pair.id, 'rejected', 'test-user');
      assert.equal(pair.provenance, 'system');
      const rejected = appDb.getMatchPairById(pair.id);
      assert.equal(rejected.provenance, 'user');

      const updated = [
        product({ id: 'a:1', name: 'Anchor Fresh Milk 2L', brand: 'Anchor', size: '2L', retailer_id: 'paknsave' }),
        product({ id: 'b:1', name: 'Anchor Fresh Milk 2L', brand: 'Anchor', size: '2L', retailer_id: 'newworld' }),
      ];
      const orch2 = new MatchingOrchestrator(appDb, updated);
      const r2 = orch2.runFuzzyCandidates();
      assert.equal(r2.inserted, 0, 'user rejection is never overwritten');
      assert.equal(r2.skipped, 1, 'user-provenance pair is skipped');
      const still = appDb.getMatchPairById(pair.id);
      assert.equal(still.review_state, 'rejected');
      assert.equal(still.provenance, 'user');
    } finally {
      appDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('acceptMatch changes state to confirmed and provenance to user', () => {
    const { appDb, dir } = setup();
    try {
      appDb.createMatchPair({
        productAId: 'a:1',
        productBId: 'b:1',
        matchMethod: 'fuzzy_candidate',
        algorithmVersion: '1.0.0',
        confidence: 0.5,
        reviewState: 'candidate',
        provenance: 'system',
        inputEvidenceHash: null,
      });

      const orch = new MatchingOrchestrator(appDb, []);
      orch.acceptMatch(1, 'alice');

      const pair = appDb.getMatchPairById(1);
      assert.equal(pair.review_state, 'confirmed');
      assert.equal(pair.provenance, 'user');
      assert.equal(pair.reviewer, 'alice');
      assert.ok(pair.reviewed_at);
    } finally {
      appDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejectMatch changes state to rejected and provenance to user', () => {
    const { appDb, dir } = setup();
    try {
      appDb.createMatchPair({
        productAId: 'a:1',
        productBId: 'b:1',
        matchMethod: 'fuzzy_candidate',
        algorithmVersion: '1.0.0',
        confidence: 0.5,
        reviewState: 'candidate',
        provenance: 'system',
        inputEvidenceHash: null,
      });

      const orch = new MatchingOrchestrator(appDb, []);
      orch.rejectMatch(1, 'bob');

      const pair = appDb.getMatchPairById(1);
      assert.equal(pair.review_state, 'rejected');
      assert.equal(pair.provenance, 'user');
      assert.equal(pair.reviewer, 'bob');
    } finally {
      appDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejectMatch throws for nonexistent pair', () => {
    const { appDb, dir } = setup();
    try {
      const orch = new MatchingOrchestrator(appDb, []);
      assert.throws(() => orch.rejectMatch(999, 'test'), /not found/);
    } finally {
      appDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('runAllMatches returns auto and fuzzy results', () => {
    const { appDb, dir } = setup();
    try {
      const products = [
        product({ id: 'paknsave:1', gtin: '9412345678901', retailer_id: 'paknsave' }),
        product({ id: 'newworld:1', gtin: '9412345678901', retailer_id: 'newworld' }),
        product({ id: 'freshchoice:1', name: 'Fresh Milk', brand: 'Anchor', retailer_id: 'freshchoice' }),
        product({ id: 'woolworths:1', name: 'Fresh Milk', brand: 'Anchor', retailer_id: 'woolworths' }),
      ];
      const orch = new MatchingOrchestrator(appDb, products);
      const result = orch.runAllMatches();
      assert.ok(result.auto.inserted > 0);
      assert.ok(result.fuzzy.inserted >= 0);
    } finally {
      appDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('getMatchesForProduct returns all pairs involving the product', () => {
    const { appDb, dir } = setup();
    try {
      appDb.createMatchPair({
        productAId: 'paknsave:1', productBId: 'newworld:1',
        matchMethod: 'auto_gtin', algorithmVersion: '1.0.0',
        confidence: 1.0, reviewState: 'confirmed', provenance: 'system', inputEvidenceHash: 'h1',
      });
      appDb.createMatchPair({
        productAId: 'paknsave:1', productBId: 'woolworths:1',
        matchMethod: 'auto_gtin', algorithmVersion: '1.0.0',
        confidence: 1.0, reviewState: 'confirmed', provenance: 'system', inputEvidenceHash: 'h2',
      });

      const matches = appDb.getMatchesForProduct('paknsave:1');
      assert.equal(matches.length, 2);
      assert.equal(appDb.getMatchesForProduct('unknown:1').length, 0);
    } finally {
      appDb.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
