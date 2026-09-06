// Parity test for deal-signal pre-materialization (DECISIONLOG 2026-09-06):
// the signals the rebuild stores in deal_signals MUST match what the runtime
// analytics produce for the same data with the same parameter set. The
// "expected" side below mirrors src/server/handlers/public.js listDeals
// exactly (observation query + calculateSales/calculateOngoingSales + filters).

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { ProjectionRepository } from '../../src/sqlite/projection-repository.js';
import { productRec, storeRec, offerRec, writeFixture } from '../server/server-helpers.js';
import { queryDealObservations } from '../../src/sqlite/deal-materialization.js';
import { calculateSales, calculateOngoingSales } from '../../src/analytics.js';
import { DEAL_SIGNALS_CALC_VERSION, DEAL_SIGNAL_PARAMS } from '../../src/sqlite/deal-materialization.js';

const DAY = 24 * 60 * 60 * 1000;
const daysAgoIso = (n) => new Date(Date.now() - n * DAY).toISOString();

function fixtureRecords() {
  return [
    productRec('paknsave:milk'), storeRec('paknsave:royaloak'),
    // history-backed: 4 baseline samples at 300, current at 200
    ...[30, 25, 20, 15].map(days =>
      offerRec('paknsave:milk', 'paknsave:royaloak', { regularCents: 300 }, { observedAt: daysAgoIso(days) })),
    offerRec('paknsave:milk', 'paknsave:royaloak', { regularCents: 200 }, { observedAt: daysAgoIso(1) }),
    // advertised: promo live now
    productRec('ww:bread'), storeRec('ww:online'),
    offerRec('ww:bread', 'ww:online', { regularCents: 250, promoCents: 200 }, {
      observedAt: daysAgoIso(1),
      promotion: { savePercent: 20 },
    }),
  ];
}

function expectedSignals(db, now) {
  const observations = queryDealObservations(db, now - DEAL_SIGNAL_PARAMS.windowDays * DAY, now).observations;
  const at = new Date(now).toISOString();
  const out = [];
  for (const sale of calculateSales(observations, {
    at, freshWithinDays: DEAL_SIGNAL_PARAMS.freshWithinDays, baselineDays: DEAL_SIGNAL_PARAMS.baselineDays,
    minSamples: DEAL_SIGNAL_PARAMS.minSamples, minDropPercent: DEAL_SIGNAL_PARAMS.minDropPercent,
    includeAllTimeLows: true, pricePolicy: DEAL_SIGNAL_PARAMS.pricePolicy,
  })) {
    const dropPercent = sale.dropPercent || 0;
    if (dropPercent <= 0 && !sale.isAllTimeLow) continue;
    out.push({
      kind: sale.isAllTimeLow ? 'all_time_low' : 'history_drop',
      productId: sale.product.id,
      referenceCents: sale.baseline?.averageCents || sale.current?.cents || 0,
      currentCents: sale.current?.cents || 0,
      dropPercent,
      calculatedAt: sale.current?.observedAt || at,
    });
  }
  for (const sale of calculateOngoingSales(observations, {
    at, freshWithinDays: DEAL_SIGNAL_PARAMS.freshWithinDays, pricePolicy: DEAL_SIGNAL_PARAMS.pricePolicy,
  })) {
    if ((sale.savePercent || 0) <= 0) continue;
    out.push({
      kind: 'advertised_only',
      productId: sale.product.id,
      referenceCents: sale.regularCents || 0,
      currentCents: sale.current?.cents || 0,
      dropPercent: sale.savePercent || 0,
      calculatedAt: sale.current?.observedAt,
    });
  }
  return out.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function storedSignals(db) {
  return db.prepare(`
    SELECT signal_kind AS kind, product_id AS productId, reference_cents AS referenceCents,
           current_cents AS currentCents, drop_percent AS dropPercent, calculated_at AS calculatedAt
    FROM deal_signals
  `).all().map(r => ({
    ...r,
    calculatedAt: new Date(r.calculatedAt).toISOString(),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

test('rebuild-materialized deal_signals match runtime analytics output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dealmat-'));
  const jsonl = join(dir, 'a.jsonl');
  const dbPath = join(dir, 'prices.db');
  writeFixture(jsonl, fixtureRecords());
  const repo = new ProjectionRepository(jsonl, dbPath);
  try {
    repo.rebuild({ force: true });
  } finally {
    repo.close();
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const expected = expectedSignals(db, Date.now());
    const actual = storedSignals(db);
    assert.equal(actual.length, 2, 'one history-backed + one advertised signal');
    assert.deepEqual(actual, expected);

    const kinds = actual.map(s => s.kind).sort();
    // 200 is below every previous price, so the runtime handler classifies
    // the milk signal all_time_low (atl wins over history_drop)
    assert.deepEqual(kinds, ['advertised_only', 'all_time_low']);
    const milk = actual.find(s => s.productId === 'paknsave:milk');
    assert.equal(milk.referenceCents, 300);
    assert.equal(milk.currentCents, 200);
    const bread = actual.find(s => s.productId === 'ww:bread');
    assert.equal(bread.referenceCents, 250);
    assert.equal(bread.currentCents, 200);
    assert.equal(bread.dropPercent, 20);

    const version = db.prepare("SELECT value FROM _meta WHERE key = 'deal_signals_calc_version'").get();
    assert.equal(version?.value, DEAL_SIGNALS_CALC_VERSION);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rebuild of an archive with no in-window offers stores zero signals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dealmat-empty-'));
  const jsonl = join(dir, 'a.jsonl');
  const dbPath = join(dir, 'prices.db');
  writeFixture(jsonl, [productRec('paknsave:x'), storeRec('paknsave:royaloak')]);
  const repo = new ProjectionRepository(jsonl, dbPath);
  try {
    repo.rebuild({ force: true });
  } finally {
    repo.close();
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) c FROM deal_signals').get().c, 0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
