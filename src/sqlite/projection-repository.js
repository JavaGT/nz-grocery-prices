import { readFileSync, renameSync, statSync, unlinkSync, mkdirSync, rmdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { classifyParsedRecord } from '../archive-records.js';
import { applyProjectionMigrations } from './schema.js';

/** Inode/content-size/high-resolution timestamp signature for change detection. */
function statSignature(filePath) {
  try {
    const stats = statSync(filePath, { bigint: true });
    return {
      dev: stats.dev,
      ino: stats.ino,
      mtimeNs: stats.mtimeNs,
      size: stats.size,
    };
  } catch (error) {
    throw new Error(`Cannot stat JSONL archive ${filePath}: ${error.message}`, {
      cause: error,
    });
  }
}

function sameSignature(a, b) {
  return a.dev === b.dev && a.ino === b.ino &&
    a.mtimeNs === b.mtimeNs && a.size === b.size;
}

// The rebuild path opens ONLY the projection DB (two-DB rule). If a caller
// points it at an application DB — data/app.db or any configured APP_DB
// path — refuse before touching anything.
function assertProjectionDbPath(dbPath) {
  const normalized = resolve(dbPath).toLowerCase();
  const appDb = resolve(process.env.APP_DB || 'data/app.db').toLowerCase();
  if (normalized === appDb) {
    throw new Error(
      `Refusing to write the projection to ${dbPath}: that is the configured application DB (APP_DB). ` +
        `The two-DB rule keeps app.db (user data) out of every rebuild path — ` +
        `projections belong in prices.db.`
    );
  }
  if (normalized.endsWith('app.db')) {
    throw new Error(
      `Refusing to write the projection to ${dbPath}: paths ending app.db are the ` +
        `application DB by convention. The two-DB rule keeps app.db (user data) out ` +
        `of every rebuild path — projections belong in prices.db.`
    );
  }
}

function bestImage(images) {
  if (!images) return null;
  if (typeof images === 'string') return images;
  if (Array.isArray(images)) return images.find(Boolean) || null;
  if (typeof images === 'object') {
    const keys = Object.keys(images).map(Number).filter(k => !Number.isNaN(k)).sort((a, b) => b - a);
    return keys.length > 0 ? images[String(keys[0])] : null;
  }
  return null;
}

const RETAILER_NAMES = {
  paknsave: "PAK'nSAVE",
  newworld: 'New World',
  woolworths: 'Woolworths',
  freshchoice: 'FreshChoice',
  warehouse: 'The Warehouse',
};

// All statements used by the rebuild insert phase, prepared exactly once per
// rebuild. Preparing per record dominated the profile (~100k SQL compiles for
// a 19k-line archive); rows produced are identical either way.
function prepareRebuildStatements(db) {
  const findContext = 'SELECT id FROM price_contexts WHERE retailer_id = ? AND store_id = ?';
  return {
    ensureRetailer: db.prepare('INSERT OR IGNORE INTO retailers(id, name) VALUES(?, ?)'),
    productFirstSeen: db.prepare('SELECT first_seen_at FROM products WHERE id = ? AND retailer_id = ?'),
    productUpsert: db.prepare(`
      INSERT INTO products(id, retailer_id, name, brand, category, image_url, size, source_id, gtin, latest_hash, first_seen_at, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id, retailer_id) DO UPDATE SET
        name = excluded.name,
        brand = excluded.brand,
        category = excluded.category,
        image_url = excluded.image_url,
        size = excluded.size,
        source_id = excluded.source_id,
        gtin = excluded.gtin,
        latest_hash = excluded.latest_hash,
        updated_at = excluded.updated_at
    `),
    productRevision: db.prepare(`
      INSERT OR IGNORE INTO product_revisions(hash, product_id, retailer_id, data, observed_at)
      VALUES(?, ?, ?, ?, ?)
    `),
    findContext: db.prepare(findContext),
    contextUpdate: db.prepare('UPDATE price_contexts SET store_name = ?, address = ?, region = ? WHERE id = ?'),
    contextInsert: db.prepare(`
      INSERT INTO price_contexts(retailer_id, store_id, store_name, scope_kind, address, region)
      VALUES(?, ?, ?, 'physical-store', ?, ?)
    `),
    lastRowid: db.prepare('SELECT last_insert_rowid() AS id'),
    storeRevision: db.prepare('INSERT OR IGNORE INTO store_revisions(hash, context_id, data, observed_at) VALUES(?, ?, ?, ?)'),
    offerProduct: db.prepare('SELECT id FROM products WHERE id = ?'),
    offerRevision: db.prepare(`
      INSERT OR IGNORE INTO offer_revisions(
        offer_key, product_id, context_id,
        rev_hash, price_regular_cents, price_promo_cents, price_member_cents,
        comparative, promotion_data, source_data, observed_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    offerExists: db.prepare('SELECT offer_key FROM offer_revisions WHERE offer_key = ?'),
    snapshotInsert: db.prepare(`
      INSERT INTO special_snapshots(context_id, observed_at, offers_hash, offer_count, added, removed)
      VALUES(?, ?, ?, ?, ?, ?)
    `),
  };
}

export class ProjectionRepository {
  #jsonlPath;
  #dbPath;
  #db;

  constructor(jsonlPath, dbPath) {
    this.#jsonlPath = jsonlPath;
    this.#dbPath = dbPath;
  }

  rebuild(options = {}) {
    const jsonlPath = options.jsonlPath || this.#jsonlPath;
    const dbPath = options.dbPath || this.#dbPath;
    const force = options.force || false;

    assertProjectionDbPath(dbPath);

    // Acquire the DB rebuild lock BEFORE reading the JSONL: mkdir is atomic,
    // so exactly one rebuild proceeds. A held lock is an error, not a queue
    // (same fail-fast policy as the archive writers). The JSONL is read and
    // fingerprinted INSIDE the lock and re-stat-verified right before the
    // publish rename, so a concurrent archive writer cannot leave this
    // rebuild advertising a fingerprint of bytes it never imported.
    const lockPath = dbPath + '.lock';
    let ownsLock = false;
    mkdirSync(dirname(dbPath), { recursive: true });
    try {
      mkdirSync(lockPath);
      ownsLock = true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      throw new Error(
        `Projection rebuild is locked by another writer (${lockPath}). ` +
          `If no rebuild is running, remove the lock directory.`
      );
    }

    try {
      return this.#rebuildLocked(jsonlPath, dbPath, force, lockPath);
    } finally {
      // Release ONLY a lock we own — never another writer's.
      if (ownsLock) {
        try { rmdirSync(lockPath); } catch { /* best-effort */ }
      }
    }
  }

  #rebuildLocked(jsonlPath, dbPath, force, lockPath) {
    let contents;
    try {
      contents = readFileSync(jsonlPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw Object.assign(new Error(`JSONL file not found: ${jsonlPath}`), { code: 'ENOENT' });
      }
      throw err;
    }

    const signatureAtRead = statSignature(jsonlPath);
    const fingerprint = createHash('sha256').update(contents).digest('hex');

    if (!force) {
      // readOnly so the skip CHECK never creates an empty DB file as a
      // side effect — a refused rebuild must leave no db artifact.
      let existingDb = null;
      try {
        existingDb = new DatabaseSync(dbPath, { readOnly: true });
        const row = existingDb.prepare("SELECT value FROM _meta WHERE key = 'jsonl_fingerprint'").get();
        if (row && row.value === fingerprint) {
          return { status: 'skipped', fingerprint };
        }
      } catch {
        // DB missing or corrupt — rebuild
      } finally {
        existingDb?.close();
      }
    }

    const pid = process.pid;
    const rand = Math.random().toString(36).slice(2, 8);
    const tmpPath = dbPath + '.tmp-' + pid + '-' + rand;

    try { unlinkSync(tmpPath); } catch { /* ok */ }

    let tmpDb = null;

    try {
      tmpDb = new DatabaseSync(tmpPath);
      // page_size must be set before WAL locks it in; 8192 packs the
      // revision tables' text payloads with less per-page overhead.
      tmpDb.exec('PRAGMA page_size=8192');
      tmpDb.exec('PRAGMA journal_mode=WAL');
      // Rebuild-only durability trade: the temp DB is throwaway (the JSONL is
      // the source of truth and publish is an atomic rename), so skips are
      // safe and save the per-commit WAL fsyncs. Per-connection setting —
      // never persisted to the published file.
      tmpDb.exec('PRAGMA synchronous=OFF');
      tmpDb.exec('PRAGMA foreign_keys=ON');

      applyProjectionMigrations(tmpDb);

      const startedAt = new Date().toISOString();
      tmpDb.prepare(
        "INSERT INTO import_runs(jsonl_path, jsonl_hash, jsonl_size, started_at, status) VALUES(?, ?, ?, ?, 'running')"
      ).run(jsonlPath, fingerprint, Buffer.byteLength(contents, 'utf8'), startedAt);

      const runId = Number(tmpDb.prepare('SELECT last_insert_rowid() AS id').get().id);

      const lines = contents.split('\n');

      // ---- Phase 1: parse/classify EVERY nonblank line first ----
      // Valid v2 records are staged by type with their original line
      // numbers; anything undecodable becomes a line-numbered error here.
      const staged = { product: [], store: [], offer: [], snapshot: [] };
      let errors = 0;
      const errorDetails = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === '') continue;

        try {
          const parsed = JSON.parse(line);
          const verdict = classifyParsedRecord(parsed);
          if (verdict.status === 'legacy') {
            throw new Error(
              `Legacy v1 archive record; run node scripts/migrate-v1-archive.js --file ${jsonlPath} first`
            );
          }
          if (verdict.status === 'invalid') {
            throw new TypeError(`Invalid archive record (${verdict.problems.join('; ')})`);
          }
          if (!(verdict.record.type in staged)) {
            throw new TypeError('Unknown archive record structure');
          }
          staged[verdict.record.type].push({ lineNumber: i + 1, record: verdict.record });
        } catch (err) {
          errors++;
          errorDetails.push(`Line ${i + 1}: ${err.message}`);
        }
      }

      // ---- Phase 2: insert dependency-first ----
      // products → stores → offers → snapshots, so an offer/snapshot line
      // that appears BEFORE its store/product context still resolves.
      // Relative order within each type is preserved. recordsImported
      // counts ACCEPTED archive lines (an INSERT OR IGNORE duplicate is
      // still an accepted, deduplicated line — not a silent skip).
      let recordsImported = 0;
      const unresolved = [];
      // One transaction for the whole insert phase: the temp DB is throwaway,
      // so a single commit is safe and removes the per-statement autocommit
      // journaling that dominated the rebuild profile. Any failure rolls back
      // and the temp DB is discarded unpublished.
      const stmts = prepareRebuildStatements(tmpDb);
      tmpDb.exec('BEGIN IMMEDIATE');
      try {
        for (const entry of staged.product) {
          const result = this.#insertRecord(stmts, entry.record);
          if (result === true) recordsImported++;
          else unresolved.push({ ...entry, reason: result });
        }
        for (const entry of staged.store) {
          const result = this.#insertRecord(stmts, entry.record);
          if (result === true) recordsImported++;
          else unresolved.push({ ...entry, reason: result });
        }
        for (const entry of staged.offer) {
          const result = this.#insertRecord(stmts, entry.record);
          if (result === true) recordsImported++;
          else unresolved.push({ ...entry, reason: result });
        }
        for (const entry of staged.snapshot) {
          const result = this.#insertRecord(stmts, entry.record);
          if (result === true) recordsImported++;
          else unresolved.push({ ...entry, reason: result });
        }
        tmpDb.exec('COMMIT');
      } catch (err) {
        try { tmpDb.exec('ROLLBACK'); } catch { /* temp DB is discarded anyway */ }
        throw err;
      }

      // A record whose references resolve NOWHERE in this archive cannot be
      // projected — inserting it is impossible and skipping it would
      // silently lose the fact (the pre-CORE-6 bug). Refuse with the
      // offending line instead of publishing a lossy projection.
      const nonEmptyLines = lines.filter(l => l.trim() !== '');
      // The v1 refusal is checked FIRST so a mixed archive always points at
      // the migrator, even when it also contains dangling references.
      const v1Details = errorDetails.filter(d => d.includes('migrate-v1-archive'));
      if (v1Details.length > 0) {
        if (recordsImported === 0) {
          throw new Error(
            `Archive contains only unrecognized/malformed records (${errors} line${errors !== 1 ? 's' : ''}, ` +
              `including ${v1Details.length} legacy v1). ` +
              `Run node scripts/migrate-v1-archive.js --file ${jsonlPath} first, then rebuild.`
          );
        }
        throw new Error(
          `Projection rebuild refused: the archive contains ${v1Details.length} legacy v1 record(s) that were NOT imported. ` +
            `Run node scripts/migrate-v1-archive.js --file ${jsonlPath} first, then rebuild.`
        );
      }
      if (unresolved.length > 0) {
        for (const entry of unresolved) {
          errors++;
          errorDetails.push(`Line ${entry.lineNumber}: ${entry.reason}`);
        }
        throw new Error(
          `Projection build failed: ${unresolved.length} unresolved record(s). ` +
            `First: ${errorDetails[errorDetails.length - unresolved.length]}. ` +
            `No projection was published.`
        );
      }

      // A v1-tainted archive must not produce a projection: refuse with the
      // actionable fix whether it is mixed with valid v2 or entirely legacy
      // (checked BEFORE publishing the temp DB).
      if (nonEmptyLines.length > 0 && recordsImported === 0) {
        throw new Error(
          `Archive contains zero valid recognized records (${errors} malformed line${errors !== 1 ? 's' : ''})`
        );
      }

      const metaStmt = tmpDb.prepare("INSERT OR REPLACE INTO _meta(key, value) VALUES(?, ?)");
      metaStmt.run('jsonl_fingerprint', fingerprint);
      metaStmt.run('jsonl_path', jsonlPath);
      metaStmt.run('built_at', new Date().toISOString());
      metaStmt.run('records_imported', String(recordsImported));
      metaStmt.run('error_count', String(errors));
      if (errors > 0) {
        metaStmt.run('last_errors', errorDetails.join('\n').slice(0, 10000));
      }

      const finishedAt = new Date().toISOString();
      tmpDb.prepare(
        "UPDATE import_runs SET records_imported = ?, errors = ?, error_detail = ?, finished_at = ?, status = 'completed' WHERE id = ?"
      ).run(
        recordsImported, errors,
        errors > 0 ? errorDetails.join('\n').slice(0, 10000) : null,
        finishedAt, runId
      );

      tmpDb.close();
      tmpDb = null;

      // Re-validate under the lock right before publishing: if the JSONL
      // changed since we read it, this rebuild's fingerprint would lie
      // about the imported bytes — refuse and let the next run re-read.
      const signatureAtPublish = statSignature(jsonlPath);
      if (!sameSignature(signatureAtRead, signatureAtPublish)) {
        throw new Error(
          `JSONL archive changed during projection rebuild (${jsonlPath}); ` +
            `refusing to publish a stale fingerprint. Re-run the rebuild.`
        );
      }

      renameSync(tmpPath, dbPath);

      return { status: 'rebuilt', fingerprint, recordsImported, errors };
    } catch (err) {
      // The temp DB may still be open on this path — close before cleanup
      // so WAL/SHM sidecars are checkpointed and removable.
      if (tmpDb) {
        try { tmpDb.close(); } catch { /* already closed */ }
        tmpDb = null;
      }
      throw err;
    } finally {
      // Clean up the temp DB AND its journal sidecars. Runs only after
      // close (or a failed open), so the published DB is never touched.
      for (const suffix of ['', '-wal', '-shm']) {
        try { unlinkSync(tmpPath + suffix); } catch { /* absent */ }
      }
    }
  }

  // Returns true when the record was inserted; otherwise returns a reason
  // for the caller to report instead of silently dropping the record.
  // `stmts` is the per-rebuild prepared-statement bundle from
  // prepareRebuildStatements().
  #insertRecord(stmts, record) {
    switch (record.type) {
      case 'product':  this.#insertProduct(stmts, record); return true;
      case 'store':    this.#insertStore(stmts, record); return true;
      case 'offer':    return this.#insertOffer(stmts, record);
      case 'snapshot': return this.#insertSnapshot(stmts, record);
      default:         return 'unknown archive record type';
    }
  }

  #ensureRetailer(stmts, id) {
    const name = RETAILER_NAMES[id] || id;
    stmts.ensureRetailer.run(id, name);
  }

  #insertProduct(stmts, record) {
    const data = record.data || {};
    const productId = record.productId;
    const retailerId = productId.split(':')[0];
    const observedAt = Date.parse(record.observedAt);
    const categories = data.categories || [];

    this.#ensureRetailer(stmts, retailerId);

    const existing = stmts.productFirstSeen.get(productId, retailerId);
    const firstSeenAt = existing ? existing.first_seen_at : observedAt;

    const imageUrl = data.image_url || bestImage(data.images) || null;

    stmts.productUpsert.run(
      productId, retailerId,
      data.name || null,
      data.brand || null,
      categories[0] || null,
      imageUrl,
      data.size || null,
      data.source_id || null,
      data.gtin || null,
      record.hash,
      firstSeenAt, observedAt
    );

    stmts.productRevision.run(record.hash, productId, retailerId, JSON.stringify(data), observedAt);
  }

  #insertStore(stmts, record) {
    const data = record.data || {};
    const storeId = record.storeId;
    // Store identity is the ENVELOPE storeId everywhere: offers/snapshots
    // look up (storeId.split(':')[0], record.storeId), so insertion must
    // key exactly that pair — never data.id/data.retailer, which are
    // display payloads and may legitimately differ from the envelope.
    const retailerId = storeId.split(':')[0];
    const observedAt = Date.parse(record.observedAt);

    this.#ensureRetailer(stmts, retailerId);

    const storeKey = storeId;
    const existing = stmts.findContext.get(retailerId, storeKey);
    let contextId;
    if (existing) {
      contextId = existing.id;
      stmts.contextUpdate.run(data.name || null, data.address || null, data.region || null, contextId);
    } else {
      const res = stmts.contextInsert.run(retailerId, storeKey, data.name || null, data.address || null, data.region || null);
      contextId = Number(res.lastInsertRowid);
    }

    stmts.storeRevision.run(record.hash, contextId, JSON.stringify(data), observedAt);
  }

  #insertOffer(stmts, record) {
    const data = record.data || {};
    const price = data.price || {};
    const observedAt = Date.parse(record.observedAt);
    const storeId = record.storeId;
    const retailerId = storeId.split(':')[0];

    const product = stmts.offerProduct.get(record.productId);
    if (!product) {
      return `offer ${record.offerId || record.offerKey} references product ${record.productId}, which has no product revision in this archive`;
    }
    const context = stmts.findContext.get(retailerId, storeId);
    // Unresolved context: return a reason so the caller refuses the build
    // instead of silently dropping this offer (pre-CORE-6-review bug).
    if (!context) {
      return `offer ${record.offerId || record.offerKey} references store context ${storeId}, which has no store revision in this archive`;
    }
    stmts.offerRevision.run(
      record.offerKey || record.offerId, record.productId, context.id,
      record.hash,
      price.regularCents != null ? price.regularCents : null,
      price.promoCents != null ? price.promoCents : null,
      price.memberCents != null ? price.memberCents : null,
      price.comparative ? JSON.stringify(price.comparative) : null,
      data.promotion ? JSON.stringify(data.promotion) : null,
      JSON.stringify(data.source),
      observedAt
    );
    return true;
  }

  #insertSnapshot(stmts, record) {
    const observedAt = Date.parse(record.observedAt);
    const storeId = record.storeId;
    const retailerId = storeId.split(':')[0];

    const context = stmts.findContext.get(retailerId, storeId);
    // Unresolved context: return a reason so the caller refuses the build
    // instead of silently dropping this snapshot.
    if (!context) {
      return `snapshot for ${storeId} references a store context with no store revision in this archive`;
    }

    const referencedOffers = [...new Set([...(record.added || []), ...(record.removed || [])])];
    const missingOffer = referencedOffers.find((offerKey) => !stmts.offerExists.get(offerKey));
    if (missingOffer) {
      return `snapshot for ${storeId} references offer ${missingOffer}, which has no offer revision in this archive`;
    }

    stmts.snapshotInsert.run(
      context.id, observedAt, record.offersHash,
      record.offerCount || 0,
      JSON.stringify(record.added || []),
      JSON.stringify(record.removed || [])
    );
    return true;
  }

  query(query = {}) {
    if (!this.#db) throw new Error('Database not open. Call open() first.');

    const from = query.from ? Date.parse(query.from) : 0;
    const to = query.to ? Date.parse(query.to) : 9007199254740991;

    let sql = `
      SELECT
        o.offer_key, o.product_id, o.context_id, o.rev_hash,
        o.price_regular_cents, o.price_promo_cents, o.price_member_cents,
        o.comparative, o.promotion_data, o.source_data, o.observed_at,
        p.name AS product_name, p.brand AS product_brand,
        p.category AS product_category, p.image_url AS product_image,
        p.gtin AS product_gtin, p.source_id AS product_source_id,
        pc.store_id, pc.store_name, pc.address AS store_address,
        pc.region AS store_region,
        r.id AS retailer_id, r.name AS retailer_name
      FROM offer_revisions o
      JOIN products p ON p.id = o.product_id
      JOIN price_contexts pc ON pc.id = o.context_id
      JOIN retailers r ON r.id = pc.retailer_id
      WHERE o.observed_at >= ? AND o.observed_at <= ?
    `;
    const params = [from, to];

    if (query.productId) { sql += ' AND o.product_id = ?'; params.push(query.productId); }
    if (query.storeId)   { sql += ' AND pc.store_id = ?'; params.push(query.storeId); }
    if (query.retailer)  { sql += ' AND r.id = ?'; params.push(query.retailer); }

    sql += ' ORDER BY o.observed_at';

    const rows = this.#db.prepare(sql).all(...params);

    if (rows.length === 0) return [];

    const listingStates = this.#buildListingStates(from, to);

    return rows.map(row => {
      const listingState = listingStates.get(row.store_id);
      const offerKey = row.offer_key;
      const inActive = listingState?.active?.has(offerKey) ?? false;

      const price = { regularCents: row.price_regular_cents };
      if (row.price_promo_cents != null) price.promoCents = row.price_promo_cents;
      if (row.price_member_cents != null) price.memberCents = row.price_member_cents;
      if (row.comparative) {
        try { price.comparative = JSON.parse(row.comparative); } catch { /* ignore */ }
      }

      const sourceData = JSON.parse(row.source_data || '{}');
      const promotionData = row.promotion_data ? JSON.parse(row.promotion_data) : undefined;

      const product = { id: row.product_id };
      if (row.product_name) product.name = row.product_name;
      if (row.product_brand) product.brand = row.product_brand;
      if (row.product_category) product.categories = [row.product_category];
      if (row.product_image) product.images = [row.product_image];
      if (row.product_gtin) product.gtin = row.product_gtin;

      const store = { id: row.store_id };
      if (row.retailer_id) store.retailer = row.retailer_id;
      if (row.store_name) store.name = row.store_name;
      if (row.store_address) store.address = row.store_address;
      if (row.store_region) store.region = row.store_region;

      const observation = {
        product: Object.assign({ categories: [], images: [] }, product),
        store: Object.assign({}, store),
        price,
        observedAt: new Date(row.observed_at).toISOString(),
        source: {
          retailerProductId: sourceData.retailerProductId || null,
          adapter: sourceData.adapter || null,
          url: sourceData.url || null,
        },
      };

      if (promotionData) {
        observation.promotion = promotionData;
      }

      if (listingState && listingState.known) {
        observation.isOnSpecial = inActive;
        if (inActive && listingState.lastSeenAt) {
          observation.lastSeenAt = new Date(listingState.lastSeenAt).toISOString();
        }
      }

      return observation;
    });
  }

  #buildListingStates(from, to) {
    const states = new Map();

    const snapshots = this.#db.prepare(`
      SELECT s.observed_at, s.added, s.removed, pc.store_id
      FROM special_snapshots s
      JOIN price_contexts pc ON pc.id = s.context_id
      ORDER BY s.observed_at
    `).all();

    for (const snap of snapshots) {
      const key = snap.store_id;
      if (!states.has(key)) {
        states.set(key, { active: new Set(), lastSeenAt: null, known: false });
      }
      const state = states.get(key);
      state.known = true;
      state.lastSeenAt = snap.observed_at;

      const added = JSON.parse(snap.added || '[]');
      const removed = JSON.parse(snap.removed || '[]');
      for (const id of added) state.active.add(id);
      for (const id of removed) state.active.delete(id);
    }

    return states;
  }

  productHistory(productId) {
    if (!this.#db) throw new Error('Database not open. Call open() first.');

    const rows = this.#db.prepare(`
      SELECT hash, product_id, data, observed_at
      FROM product_revisions
      WHERE product_id = ?
      ORDER BY observed_at DESC
    `).all(productId);

    return rows.map(row => ({
      hash: row.hash,
      observedAt: new Date(row.observed_at).toISOString(),
      product: JSON.parse(row.data || '{}'),
    }));
  }

  open(db) {
    if (db) {
      this.#db = db;
    } else {
      this.#db = new DatabaseSync(this.#dbPath);
      this.#db.exec('PRAGMA journal_mode=WAL');
      this.#db.exec('PRAGMA foreign_keys=ON');
    }
    return this;
  }

  close() {
    if (this.#db) {
      this.#db.close();
      this.#db = null;
    }
  }

  get db() {
    return this.#db;
  }

  get jsonlPath() {
    return this.#jsonlPath;
  }

  get dbPath() {
    return this.#dbPath;
  }
}
