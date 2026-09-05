// Content-identity check for projection DBs: row counts per table, integer
// aggregates per hot table, _meta (minus run-varying keys), schema, and
// import_runs outcome. Usage: node test/tools/compare-db-content.js <a.db> <b.db>
import { DatabaseSync } from 'node:sqlite';

function summarize(path) {
  const db = new DatabaseSync(path, { readOnly: true, readBigInts: true });
  const s = (v) => (typeof v === 'bigint' ? v.toString() : v);
  const tables = ['retailers', 'products', 'product_revisions', 'price_contexts',
    'store_revisions', 'offer_revisions', 'special_snapshots', 'import_runs', '_meta'];
  const out = {};
  for (const t of tables) out[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n.toString();
  const one = (sql) => Object.fromEntries(
    Object.entries(db.prepare(sql).get()).map(([k, v]) => [k, s(v)])
  );
  out.offerAgg = one(`SELECT COUNT(*) AS n, SUM(price_regular_cents) AS s, SUM(price_promo_cents) AS p,
    SUM(price_member_cents) AS m, SUM(observed_at) AS o, SUM(length(source_data)) AS sd FROM offer_revisions`);
  out.productAgg = one(`SELECT COUNT(*) AS n, SUM(first_seen_at) AS fs, SUM(updated_at) AS u,
    SUM(length(name)) AS nl FROM products`);
  out.snapshotAgg = one('SELECT SUM(offer_count) AS oc, SUM(observed_at) AS o FROM special_snapshots');
  out.contextAgg = one('SELECT COUNT(*) AS n, SUM(id) AS ids FROM price_contexts');
  out.revisionAgg = one(`SELECT (SELECT COUNT(*) FROM product_revisions) AS pr,
    (SELECT COUNT(*) FROM store_revisions) AS sr,
    (SELECT SUM(length(data)) FROM product_revisions) AS prd,
    (SELECT SUM(length(data)) FROM store_revisions) AS srd`);
  // _meta minus keys that legitimately vary per run (wall-clock, absolute path)
  out.meta = db.prepare('SELECT key, value FROM _meta ORDER BY key').all()
    .filter((r) => !['built_at', 'jsonl_path'].includes(r.key));
  out.schema = db.prepare(
    `SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`
  ).all();
  out.importRuns = db.prepare('SELECT records_imported, errors, status FROM import_runs').all();
  db.close();
  return out;
}

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) {
  console.error('Usage: node test/tools/compare-db-content.js <before.db> <after.db>');
  process.exit(2);
}
const a = JSON.stringify(summarize(aPath), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
const b = JSON.stringify(summarize(bPath), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
if (a === b) {
  console.log(`IDENTICAL: ${aPath} === ${bPath} (row counts, aggregates, schema, meta)`);
} else {
  console.log(`MISMATCH: ${aPath} vs ${bPath}`);
  const ao = summarize(aPath);
  const bo = summarize(bPath);
  for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    if (JSON.stringify(ao[k]) !== JSON.stringify(bo[k])) {
      console.log(`  ${k}\n   before: ${JSON.stringify(ao[k]).slice(0, 300)}\n   after:  ${JSON.stringify(bo[k]).slice(0, 300)}`);
    }
  }
  process.exit(1);
}
