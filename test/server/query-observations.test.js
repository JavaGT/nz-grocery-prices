import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createTestServer, productRec, storeRec, offerRec, daysAgo } from './server-helpers.js';
import { defaultQueryDbObservations } from '../../src/server/handlers/public.js';

// Locks the observation-mapping contract of defaultQueryDbObservations — the
// row feed for the deals analytics. The mapping is hot (one row per offer
// revision in the 90-day window), so it memoizes ISO timestamp strings and
// skips work that would not change its output; these tests pin that output.
describe('defaultQueryDbObservations', () => {
  let srv;

  before(async () => {
    const day = (n) => daysAgo(n);
    srv = await createTestServer({
      records: [
        productRec('paknsave:milk', { data: { name: 'Milk 1L' } }),
        productRec('paknsave:bread', { data: { name: 'Bread' } }),
        productRec('newworld:eggs', { data: { name: 'Eggs' } }),
        productRec('newworld:toast', { data: { name: 'Toast' } }),
        storeRec('paknsave:001'),
        storeRec('newworld:001'),
        // Advertised reduction with a promotion blob -> promotion attached.
        offerRec('paknsave:milk', 'paknsave:001',
          { regularCents: 1000, promoCents: 800 }, { observedAt: day(3), promotion: { startsAt: day(4), endsAt: day(1), savePercent: 20 } }),
        // Same run timestamp as the milk row: exercises the ISO memoization path.
        offerRec('paknsave:bread', 'paknsave:001',
          { regularCents: 500 }, { observedAt: day(3) }),
        // Comparative price JSON is surfaced parsed on the price object.
        offerRec('newworld:eggs', 'newworld:001',
          { regularCents: 700, comparative: { type: 'was', price: 900 } }, { observedAt: day(2) }),
        // Reduction without a promotion blob: on special, no promotion property.
        offerRec('newworld:toast', 'newworld:001',
          { regularCents: 400, promoCents: 300 }, { observedAt: day(1) }),
      ],
    });
  });

  after(async () => {
    await srv.close();
  });

  function queryWindow() {
    const db = new DatabaseSync(srv.dir.pricesDb, { readOnly: true });
    try {
      const toMs = Date.now();
      const fromMs = toMs - 90 * 24 * 60 * 60 * 1000;
      return defaultQueryDbObservations(db, fromMs, toMs);
    } finally {
      db.close();
    }
  }

  it('maps offer revisions into observation objects in observed_at order', () => {
    const observations = queryWindow();
    assert.equal(observations.length, 4);
    const epoch = observations.map(o => Date.parse(o.observedAt));
    assert.deepEqual(epoch, [...epoch].sort((a, b) => a - b));
    for (const o of observations) {
      assert.equal(o.observedAt, o.lastSeenAt);
      assert.ok(!Number.isNaN(Date.parse(o.observedAt)));
      assert.deepEqual(
        Object.keys(o).filter(k => k !== 'promotion').sort(),
        ['isOnSpecial', 'lastSeenAt', 'observedAt', 'price', 'product', 'store']);
    }
  });

  it('attaches promotion only for rows with a real reduction and promotion data', () => {
    const observations = queryWindow();
    const milk = observations.find(o => o.product.id === 'paknsave:milk');
    assert.equal(milk.isOnSpecial, true);
    assert.equal(milk.promotion.savePercent, 20);

    // Reduction without a promotion blob: on special, no promotion property.
    const toast = observations.find(o => o.product.id === 'newworld:toast');
    assert.equal(toast.isOnSpecial, true);
    assert.equal('promotion' in toast, false);

    // No reduction -> no promotion property even if the shape is otherwise equal.
    const eggs = observations.find(o => o.product.id === 'newworld:eggs');
    assert.equal(eggs.isOnSpecial, false);
    assert.equal('promotion' in eggs, false);
  });

  it('parses comparative price JSON and keeps optional cents truly optional', () => {
    const observations = queryWindow();
    const eggs = observations.find(o => o.product.id === 'newworld:eggs');
    assert.deepEqual(eggs.price.comparative, { type: 'was', price: 900 });
    const bread = observations.find(o => o.product.id === 'paknsave:bread');
    assert.equal(bread.price.comparative, undefined);
    assert.equal(bread.price.promoCents, undefined);
    assert.equal(bread.price.memberCents, undefined);
    assert.equal('promotion' in bread, false);
  });

  it('yields the same ISO timestamp string for rows sharing an observed_at', () => {
    const observations = queryWindow();
    const milk = observations.find(o => o.product.id === 'paknsave:milk');
    const bread = observations.find(o => o.product.id === 'paknsave:bread');
    assert.equal(milk.observedAt, bread.observedAt);
  });
});
