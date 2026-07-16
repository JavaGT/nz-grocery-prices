import { readFileSync, renameSync, unlinkSync, mkdirSync, rmdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { applyProjectionMigrations } from './schema.js';

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

    let contents;
    try {
      contents = readFileSync(jsonlPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw Object.assign(new Error(`JSONL file not found: ${jsonlPath}`), { code: 'ENOENT' });
      }
      throw err;
    }

    const fingerprint = createHash('sha256').update(contents).digest('hex');

    if (!force) {
      try {
        const existingDb = new DatabaseSync(dbPath);
        existingDb.exec('PRAGMA journal_mode=WAL');
        const row = existingDb.prepare("SELECT value FROM _meta WHERE key = 'jsonl_fingerprint'").get();
        existingDb.close();
        if (row && row.value === fingerprint) {
          return { status: 'skipped', fingerprint };
        }
      } catch {
        // DB missing or corrupt — rebuild
      }
    }

    const pid = process.pid;
    const rand = Math.random().toString(36).slice(2, 8);
    const tmpPath = dbPath + '.tmp-' + pid + '-' + rand;

    // Acquire rebuild lock (mkdir is atomic on all platforms)
    const lockPath = dbPath + '.lock';
    function acquireLock() {
      for (let i = 0; i < 50; i++) {
        try { mkdirSync(lockPath); return true; } catch {
          const deadline = Date.now() + 10;
          while (Date.now() < deadline) { /* spin */ }
        }
      }
      return false;
    }
    function releaseLock() {
      try { rmdirSync(lockPath); } catch { /* ok */ }
    }

    try { unlinkSync(tmpPath); } catch { /* ok */ }

    mkdirSync(dirname(dbPath), { recursive: true });

    const tmpDb = new DatabaseSync(tmpPath);

    try {
      tmpDb.exec('PRAGMA journal_mode=WAL');
      tmpDb.exec('PRAGMA foreign_keys=ON');

      applyProjectionMigrations(tmpDb);

      const startedAt = new Date().toISOString();
      tmpDb.prepare(
        "INSERT INTO import_runs(jsonl_path, jsonl_hash, jsonl_size, started_at, status) VALUES(?, ?, ?, ?, 'running')"
      ).run(jsonlPath, fingerprint, Buffer.byteLength(contents, 'utf8'), startedAt);

      const runId = Number(tmpDb.prepare('SELECT last_insert_rowid() AS id').get().id);

      const lines = contents.split('\n');
      let recordsImported = 0;
      let errors = 0;
      const errorDetails = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === '') continue;

        try {
          const record = JSON.parse(line);
          if (record.version === 2 && record.type) {
            this.#insertRecord(tmpDb, record);
            recordsImported++;
          } else if (record.product && record.store && record.price && record.source) {
            recordsImported++;
          } else {
            throw new TypeError('Unknown archive record structure');
          }
        } catch (err) {
          errors++;
          errorDetails.push(`Line ${i + 1}: ${err.message}`);
        }
      }

      const nonEmptyLines = lines.filter(l => l.trim() !== '');
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

      acquireLock();
      try {
        renameSync(tmpPath, dbPath);
      } finally {
        releaseLock();
      }

      return { status: 'rebuilt', fingerprint, recordsImported, errors };
    } catch (err) {
      try { unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }

  #insertRecord(db, record) {
    switch (record.type) {
      case 'product':  this.#insertProduct(db, record); break;
      case 'store':    this.#insertStore(db, record); break;
      case 'offer':    this.#insertOffer(db, record); break;
      case 'snapshot': this.#insertSnapshot(db, record); break;
    }
  }

  #ensureRetailer(db, id) {
    const name = RETAILER_NAMES[id] || id;
    db.prepare("INSERT OR IGNORE INTO retailers(id, name) VALUES(?, ?)").run(id, name);
  }

  #insertProduct(db, record) {
    const data = record.data || {};
    const productId = record.productId;
    const retailerId = productId.split(':')[0];
    const observedAt = Date.parse(record.observedAt);
    const categories = data.categories || [];

    this.#ensureRetailer(db, retailerId);

    const existing = db.prepare("SELECT first_seen_at FROM products WHERE id = ? AND retailer_id = ?").get(productId, retailerId);
    const firstSeenAt = existing ? existing.first_seen_at : observedAt;

    const imageUrl = data.image_url || bestImage(data.images) || null;

    db.prepare(`
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
    `).run(
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

    db.prepare(`
      INSERT OR IGNORE INTO product_revisions(hash, product_id, retailer_id, data, observed_at)
      VALUES(?, ?, ?, ?, ?)
    `).run(record.hash, productId, retailerId, JSON.stringify(data), observedAt);
  }

  #insertStore(db, record) {
    const data = record.data || {};
    const storeId = record.storeId;
    const retailerId = data.retailer || storeId.split(':')[0];
    const observedAt = Date.parse(record.observedAt);

    this.#ensureRetailer(db, retailerId);

    const storeKey = data.id || storeId;
    const existing = db.prepare("SELECT id FROM price_contexts WHERE retailer_id = ? AND store_id = ?").get(retailerId, storeKey);
    let contextId;
    if (existing) {
      contextId = existing.id;
      db.prepare("UPDATE price_contexts SET store_name = ?, address = ?, region = ? WHERE id = ?")
        .run(data.name || null, data.address || null, data.region || null, contextId);
    } else {
      const res = db.prepare(`
        INSERT INTO price_contexts(retailer_id, store_id, store_name, scope_kind, address, region)
        VALUES(?, ?, ?, 'physical-store', ?, ?)
      `).run(retailerId, storeKey, data.name || null, data.address || null, data.region || null);
      contextId = Number(db.prepare('SELECT last_insert_rowid() AS id').get().id);
    }

    db.prepare("INSERT OR IGNORE INTO store_revisions(hash, context_id, data, observed_at) VALUES(?, ?, ?, ?)")
      .run(record.hash, contextId, JSON.stringify(data), observedAt);
  }

  #insertOffer(db, record) {
    const data = record.data || {};
    const price = data.price || {};
    const observedAt = Date.parse(record.observedAt);
    const storeId = record.storeId;
    const retailerId = storeId.split(':')[0];

    const context = db.prepare("SELECT id FROM price_contexts WHERE retailer_id = ? AND store_id = ?").get(retailerId, storeId);
    if (!context) return;

    db.prepare(`
      INSERT OR IGNORE INTO offer_revisions(
        offer_key, product_id, context_id,
        rev_hash, price_regular_cents, price_promo_cents, price_member_cents,
        comparative, promotion_data, source_data, observed_at
      ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
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
  }

  #insertSnapshot(db, record) {
    const observedAt = Date.parse(record.observedAt);
    const storeId = record.storeId;
    const retailerId = storeId.split(':')[0];

    const context = db.prepare("SELECT id FROM price_contexts WHERE retailer_id = ? AND store_id = ?").get(retailerId, storeId);
    if (!context) return;

    db.prepare(`
      INSERT INTO special_snapshots(context_id, observed_at, offers_hash, offer_count, added, removed)
      VALUES(?, ?, ?, ?, ?, ?)
    `).run(
      context.id, observedAt, record.offersHash,
      record.offerCount || 0,
      JSON.stringify(record.added || []),
      JSON.stringify(record.removed || [])
    );
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
