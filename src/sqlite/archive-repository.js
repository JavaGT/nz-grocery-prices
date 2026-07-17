import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { applyArchiveMigrations, ensureMigrationTable } from './schema.js';

const RETAILER_NAMES = {
  paknsave: "PAK'nSAVE",
  newworld: 'New World',
  woolworths: 'Woolworths',
  freshchoice: 'FreshChoice',
  warehouse: 'The Warehouse',
};

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

function fingerprint(value) {
  return createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function offerKeyOf(productId, storeId) {
  return `${productId}\u0000${storeId}`;
}

function filterObservations(observations, query = {}) {
  const from = query.from ? Date.parse(query.from) : Number.NEGATIVE_INFINITY;
  const to = query.to ? Date.parse(query.to) : Number.POSITIVE_INFINITY;

  return observations
    .filter((observation) => {
      const timestamp = Date.parse(observation.observedAt);
      return (
        (!query.productId || observation.product.id === query.productId) &&
        (!query.storeId || observation.store.id === query.storeId) &&
        (!query.retailer || observation.store.retailer === query.retailer) &&
        timestamp >= from &&
        timestamp <= to
      );
    })
    .sort((left, right) => Date.parse(left.observedAt) - Date.parse(right.observedAt))
    .map((observation) => structuredClone(observation));
}

/** Pick a single display image URL from the various shapes retailers use. */
function pickImage(images) {
  if (!images) return null;
  if (typeof images === 'string') return images || null;
  if (Array.isArray(images)) {
    for (const item of images) {
      if (typeof item === 'string' && item) return item;
      if (item && typeof item === 'object') {
        const url = item.uri || item.url || item.src || item.primary;
        if (typeof url === 'string' && url) return url;
      }
    }
    return null;
  }
  if (typeof images === 'object') {
    const direct = images.primary || images.big || images.small
      || images['400'] || images['200'] || images['500'] || images['100'];
    if (typeof direct === 'string' && direct) return direct;
    const first = Object.values(images).find((v) => typeof v === 'string' && v);
    return first || null;
  }
  return null;
}

/** Effective shelf price: promo beats member beats regular. */
function effectiveCents(price = {}) {
  if (Number.isFinite(price.promoCents)) return price.promoCents;
  if (Number.isFinite(price.memberCents)) return price.memberCents;
  if (Number.isFinite(price.regularCents)) return price.regularCents;
  return null;
}

const DEAL_DAY_MS = 24 * 60 * 60 * 1000;

/** Mirror of analytics.promotionIsActive for the SQL-bounded deal feed. */
function promotionActive(promotion, atMs) {
  const startsAt = promotion?.startsAt ? Date.parse(promotion.startsAt) : undefined;
  const endsAt = promotion?.endsAt ? Date.parse(promotion.endsAt) : undefined;
  return (!Number.isFinite(startsAt) || startsAt <= atMs)
    && (!Number.isFinite(endsAt) || endsAt >= atMs);
}

/**
 * Normalized authoritative archive (Option 4).
 * Single local writer; never opens app.db; prices.db stays a separate projection.
 */
export class SqliteArchiveRepository {
  #db;
  #dbPath;
  #stmts;

  constructor(dbPath = 'data/archive.db') {
    this.#dbPath = resolve(dbPath);
    mkdirSync(dirname(this.#dbPath), { recursive: true });
    this.#db = new DatabaseSync(this.#dbPath);
    this.#db.exec('PRAGMA journal_mode=WAL');
    this.#db.exec('PRAGMA foreign_keys=ON');
    this.#db.exec('PRAGMA busy_timeout=5000');
    ensureMigrationTable(this.#db);
    applyArchiveMigrations(this.#db);
    this.#stmts = this.#prepare();
    this.#ensureListings();
  }

  /** Build the flat read model once for archives that predate it. */
  #ensureListings() {
    try {
      const built = this.#db.prepare("SELECT value FROM _meta WHERE key = 'listings_built'").get();
      if (built) return;
      this.rebuildListings();
    } catch { /* best-effort; append() maintains listings incrementally */ }
  }

  get dbPath() {
    return this.#dbPath;
  }

  #prepare() {
    const db = this.#db;
    return {
      getSeq: db.prepare('SELECT next_seq AS seq FROM archive_seq WHERE id = 1'),
      bumpSeq: db.prepare('UPDATE archive_seq SET next_seq = next_seq + 1 WHERE id = 1'),
      ensureRetailer: db.prepare('INSERT OR IGNORE INTO retailers(id, name) VALUES(?, ?)'),
      getContext: db.prepare('SELECT id, store_name FROM price_contexts WHERE retailer_id = ? AND store_id = ?'),
      insertContext: db.prepare(
        'INSERT INTO price_contexts(retailer_id, store_id, store_name, address, region) VALUES(?, ?, ?, ?, ?)',
      ),
      updateContext: db.prepare(
        'UPDATE price_contexts SET store_name = ?, address = ?, region = ? WHERE id = ?',
      ),
      productRevExists: db.prepare('SELECT 1 AS ok FROM product_revisions WHERE hash = ?'),
      insertProductRev: db.prepare(
        'INSERT INTO product_revisions(hash, product_id, retailer_id, data, observed_at, seq) VALUES(?, ?, ?, ?, ?, ?)',
      ),
      latestProduct: db.prepare('SELECT hash FROM latest_product_revisions WHERE product_id = ?'),
      upsertLatestProduct: db.prepare(`
        INSERT INTO latest_product_revisions(product_id, hash, observed_at, seq)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(product_id) DO UPDATE SET
          hash = excluded.hash,
          observed_at = excluded.observed_at,
          seq = excluded.seq
      `),
      storeRevExists: db.prepare('SELECT 1 AS ok FROM store_revisions WHERE hash = ?'),
      insertStoreRev: db.prepare(
        'INSERT INTO store_revisions(hash, context_id, data, observed_at, seq) VALUES(?, ?, ?, ?, ?)',
      ),
      latestStore: db.prepare('SELECT hash FROM latest_store_revisions WHERE context_id = ?'),
      upsertLatestStore: db.prepare(`
        INSERT INTO latest_store_revisions(context_id, hash, observed_at, seq)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(context_id) DO UPDATE SET
          hash = excluded.hash,
          observed_at = excluded.observed_at,
          seq = excluded.seq
      `),
      getIdentity: db.prepare('SELECT id FROM offer_identities WHERE offer_key = ?'),
      insertIdentity: db.prepare(
        'INSERT INTO offer_identities(offer_key, product_id, context_id) VALUES(?, ?, ?)',
      ),
      latestOffer: db.prepare('SELECT rev_hash FROM latest_offer_revisions WHERE identity_id = ?'),
      insertOfferRev: db.prepare(`
        INSERT INTO offer_revisions(
          identity_id, rev_hash, price_regular_cents, price_promo_cents, price_member_cents,
          comparative, promotion_data, source_data, observed_at, seq
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `),
      upsertLatestOffer: db.prepare(`
        INSERT INTO latest_offer_revisions(identity_id, rev_hash, revision_id, observed_at, seq)
        VALUES(?, ?, ?, ?, ?)
        ON CONFLICT(identity_id) DO UPDATE SET
          rev_hash = excluded.rev_hash,
          revision_id = excluded.revision_id,
          observed_at = excluded.observed_at,
          seq = excluded.seq
      `),
      insertSnapshot: db.prepare(`
        INSERT INTO listing_snapshots(context_id, scope, observed_at, offers_hash, offer_count, seq)
        VALUES(?, ?, ?, ?, ?, ?)
      `),
      insertChange: db.prepare(
        'INSERT INTO listing_snapshot_changes(snapshot_id, identity_id, change) VALUES(?, ?, ?)',
      ),
      activeMembers: db.prepare(
        'SELECT identity_id FROM active_special_offers WHERE context_id = ? AND scope = ?',
      ),
      insertActive: db.prepare(`
        INSERT INTO active_special_offers(context_id, scope, identity_id, last_seen_at)
        VALUES(?, ?, ?, ?)
        ON CONFLICT(context_id, scope, identity_id) DO UPDATE SET last_seen_at = excluded.last_seen_at
      `),
      deleteActive: db.prepare(
        'DELETE FROM active_special_offers WHERE context_id = ? AND scope = ? AND identity_id = ?',
      ),
      upsertListing: db.prepare(`
        INSERT INTO product_listings(
          product_id, retailer, name, brand, image_url, category, gtin,
          store_id, store_name, current_cents, regular_cents, last_seen, search_text
        ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(product_id, retailer) DO UPDATE SET
          name = excluded.name,
          brand = excluded.brand,
          image_url = excluded.image_url,
          category = excluded.category,
          gtin = excluded.gtin,
          store_id = excluded.store_id,
          store_name = excluded.store_name,
          current_cents = excluded.current_cents,
          regular_cents = excluded.regular_cents,
          last_seen = excluded.last_seen,
          search_text = excluded.search_text
        WHERE excluded.last_seen >= product_listings.last_seen
      `),
      lastInsert: db.prepare('SELECT last_insert_rowid() AS id'),
    };
  }

  /** Upsert one flat read-model row, keeping the most-recently-seen offer. */
  #writeListing({ productId, retailer, product = {}, storeId, storeName, currentCents, regularCents, lastSeen }) {
    const name = product.name ?? null;
    const brand = product.brand ?? null;
    const category = Array.isArray(product.categories) ? (product.categories[0] ?? null) : null;
    const gtin = product.gtin ?? null;
    const searchText = [name, brand, category].filter(Boolean).join(' ').toLowerCase();
    this.#stmts.upsertListing.run(
      productId,
      retailer,
      name,
      brand,
      pickImage(product.images),
      category,
      gtin,
      storeId ?? null,
      storeName ?? null,
      currentCents ?? null,
      regularCents ?? null,
      Number.isFinite(lastSeen) ? lastSeen : Date.now(),
      searchText || null,
    );
  }

  /** Maintain the flat read model from a freshly appended observation. */
  #upsertListing(observation) {
    const product = observation.product || {};
    const store = observation.store || {};
    const price = observation.price || {};
    this.#writeListing({
      productId: product.id,
      retailer: store.retailer || String(product.id || '').split(':')[0],
      product,
      storeId: store.id,
      storeName: store.name,
      currentCents: effectiveCents(price),
      regularCents: Number.isFinite(price.regularCents) ? price.regularCents : null,
      lastSeen: Date.parse(observation.observedAt),
    });
  }

  #allocSeq() {
    const row = this.#stmts.getSeq.get();
    this.#stmts.bumpSeq.run();
    return Number(row.seq);
  }

  #ensureRetailer(retailerId) {
    const name = RETAILER_NAMES[retailerId] || retailerId;
    this.#stmts.ensureRetailer.run(retailerId, name);
  }

  #ensureContext(store) {
    const retailerId = store.retailer || store.id.split(':')[0];
    this.#ensureRetailer(retailerId);
    const storeKey = store.id;
    const existing = this.#stmts.getContext.get(retailerId, storeKey);
    if (existing) {
      this.#stmts.updateContext.run(
        store.name || existing.store_name || null,
        store.address || null,
        store.region || null,
        existing.id,
      );
      return Number(existing.id);
    }
    this.#stmts.insertContext.run(
      retailerId,
      storeKey,
      store.name || null,
      store.address || null,
      store.region || null,
    );
    return Number(this.#stmts.lastInsert.get().id);
  }

  #ensureIdentity(productId, contextId, storeId) {
    const offerKey = offerKeyOf(productId, storeId);
    const existing = this.#stmts.getIdentity.get(offerKey);
    if (existing) return { id: Number(existing.id), offerKey };
    this.#stmts.insertIdentity.run(offerKey, productId, contextId);
    return { id: Number(this.#stmts.lastInsert.get().id), offerKey };
  }

  /** Resolve price_contexts.id for a store_id (prefers existing row over id-prefix guess). */
  #contextIdForStore(storeId) {
    const existing = this.#db.prepare(
      'SELECT id, retailer_id FROM price_contexts WHERE store_id = ? LIMIT 1',
    ).get(storeId);
    if (existing) return Number(existing.id);

    const retailerId = String(storeId).split(':')[0];
    this.#ensureRetailer(retailerId);
    this.#stmts.insertContext.run(retailerId, storeId, null, null, null);
    return Number(this.#stmts.lastInsert.get().id);
  }

  #insertProduct(observation) {
    const product = observation.product;
    const hash = fingerprint(product);
    const latest = this.#stmts.latestProduct.get(product.id);
    if (latest?.hash === hash) return 0;
    if (this.#stmts.productRevExists.get(hash)) {
      this.#stmts.upsertLatestProduct.run(
        product.id,
        hash,
        Date.parse(observation.observedAt),
        this.#allocSeq(),
      );
      return 0;
    }
    const retailerId = product.id.split(':')[0];
    this.#ensureRetailer(retailerId);
    const seq = this.#allocSeq();
    const observedAt = Date.parse(observation.observedAt);
    this.#stmts.insertProductRev.run(
      hash,
      product.id,
      retailerId,
      JSON.stringify(product),
      observedAt,
      seq,
    );
    this.#stmts.upsertLatestProduct.run(product.id, hash, observedAt, seq);
    return 1;
  }

  #insertStore(observation) {
    const store = observation.store;
    const hash = fingerprint(store);
    const contextId = this.#ensureContext(store);
    const latest = this.#stmts.latestStore.get(contextId);
    if (latest?.hash === hash) return { added: 0, contextId };
    if (this.#stmts.storeRevExists.get(hash)) {
      this.#stmts.upsertLatestStore.run(
        contextId,
        hash,
        Date.parse(observation.observedAt),
        this.#allocSeq(),
      );
      return { added: 0, contextId };
    }
    const seq = this.#allocSeq();
    const observedAt = Date.parse(observation.observedAt);
    this.#stmts.insertStoreRev.run(hash, contextId, JSON.stringify(store), observedAt, seq);
    this.#stmts.upsertLatestStore.run(contextId, hash, observedAt, seq);
    return { added: 1, contextId };
  }

  #insertOffer(observation, contextId) {
    const productId = observation.product.id;
    const storeId = observation.store.id;
    const { id: identityId } = this.#ensureIdentity(productId, contextId, storeId);
    const data = {
      price: structuredClone(observation.price),
      ...(observation.promotion ? { promotion: structuredClone(observation.promotion) } : {}),
      source: structuredClone(observation.source),
    };
    const hash = fingerprint(data);
    const latest = this.#stmts.latestOffer.get(identityId);
    if (latest?.rev_hash === hash) return { added: 0, identityId };

    const price = data.price || {};
    const seq = this.#allocSeq();
    const observedAt = Date.parse(observation.observedAt);
    this.#stmts.insertOfferRev.run(
      identityId,
      hash,
      price.regularCents != null ? price.regularCents : 0,
      price.promoCents != null ? price.promoCents : null,
      price.memberCents != null ? price.memberCents : null,
      price.comparative ? JSON.stringify(price.comparative) : null,
      data.promotion ? JSON.stringify(data.promotion) : null,
      JSON.stringify(data.source),
      observedAt,
      seq,
    );
    const revisionId = Number(this.#stmts.lastInsert.get().id);
    this.#stmts.upsertLatestOffer.run(identityId, hash, revisionId, observedAt, seq);
    return { added: 1, identityId };
  }

  #insertSnapshot(scope, storeId, contextId, observedAtIso, currentIdentityIds) {
    const previous = new Set(
      this.#stmts.activeMembers.all(contextId, scope).map((row) => Number(row.identity_id)),
    );
    const current = new Set(currentIdentityIds);
    const added = [...current].filter((id) => !previous.has(id)).sort((a, b) => a - b);
    const removed = [...previous].filter((id) => !current.has(id)).sort((a, b) => a - b);

    const offerPairs = [...current]
      .sort((a, b) => a - b)
      .map((id) => {
        const latest = this.#stmts.latestOffer.get(id);
        return [id, latest?.rev_hash];
      });
    const offersHash = fingerprint(offerPairs);
    const observedAt = Date.parse(observedAtIso);
    const seq = this.#allocSeq();
    this.#stmts.insertSnapshot.run(
      contextId,
      scope,
      observedAt,
      offersHash,
      current.size,
      seq,
    );
    const snapshotId = Number(this.#stmts.lastInsert.get().id);
    for (const identityId of added) {
      this.#stmts.insertChange.run(snapshotId, identityId, 'added');
      this.#stmts.insertActive.run(contextId, scope, identityId, observedAt);
    }
    for (const identityId of removed) {
      this.#stmts.insertChange.run(snapshotId, identityId, 'removed');
      this.#stmts.deleteActive.run(contextId, scope, identityId);
    }
    return 1;
  }

  /**
   * Append observations. options.snapshotScope (e.g. "specials") records listing deltas.
   * Returns number of new archive rows (product+store+offer+snapshot).
   */
  async append(observations, options = {}) {
    if (!observations?.length) return 0;

    let productsAdded = 0;
    let storesAdded = 0;
    let offersAdded = 0;
    let snapshotsAdded = 0;
    const listings = new Map();

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      for (const observation of observations) {
        productsAdded += this.#insertProduct(observation);
        const storeResult = this.#insertStore(observation);
        storesAdded += storeResult.added;
        const offerResult = this.#insertOffer(observation, storeResult.contextId);
        offersAdded += offerResult.added;
        this.#upsertListing(observation);

        if (options.snapshotScope) {
          const current = listings.get(observation.store.id) ?? {
            observedAt: observation.observedAt,
            contextId: storeResult.contextId,
            identityIds: new Set(),
          };
          current.identityIds.add(offerResult.identityId);
          current.contextId = storeResult.contextId;
          if (Date.parse(observation.observedAt) > Date.parse(current.observedAt)) {
            current.observedAt = observation.observedAt;
          }
          listings.set(observation.store.id, current);
        }
      }

      if (options.snapshotScope) {
        for (const [storeId, listing] of listings) {
          snapshotsAdded += this.#insertSnapshot(
            options.snapshotScope,
            storeId,
            listing.contextId,
            listing.observedAt,
            listing.identityIds,
          );
        }
      }

      this.#db.exec('COMMIT');
    } catch (err) {
      try { this.#db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }

    return productsAdded + storesAdded + offersAdded + snapshotsAdded;
  }

  async productHistory(productId) {
    const rows = this.#db.prepare(`
      SELECT hash, data, observed_at
      FROM product_revisions
      WHERE product_id = ?
      ORDER BY observed_at ASC, seq ASC
    `).all(productId);

    return rows.map((row) => ({
      hash: row.hash,
      observedAt: new Date(row.observed_at).toISOString(),
      product: JSON.parse(row.data),
    }));
  }

  #listingState(scope, contextId, asOf) {
    const snapshots = this.#db.prepare(`
      SELECT id, observed_at
      FROM listing_snapshots
      WHERE context_id = ? AND scope = ? AND observed_at <= ?
      ORDER BY observed_at ASC, seq ASC
    `).all(contextId, scope, asOf);

    const active = new Set();
    let lastSeenAt;
    let known = false;
    for (const snap of snapshots) {
      known = true;
      lastSeenAt = snap.observed_at;
      const changes = this.#db.prepare(
        'SELECT identity_id, change FROM listing_snapshot_changes WHERE snapshot_id = ?',
      ).all(snap.id);
      for (const change of changes) {
        if (change.change === 'added') active.add(Number(change.identity_id));
        else active.delete(Number(change.identity_id));
      }
    }
    return { active, lastSeenAt, known };
  }

  async query(query = {}) {
    const from = query.from ? Date.parse(query.from) : Number.NEGATIVE_INFINITY;
    const to = query.to ? Date.parse(query.to) : Number.POSITIVE_INFINITY;
    const asOf = Number.isFinite(to) && to !== Number.POSITIVE_INFINITY ? to : Date.now();

    let sql = `
      SELECT
        oi.id AS identity_id,
        oi.offer_key,
        oi.product_id,
        oi.context_id,
        o.rev_hash,
        o.price_regular_cents,
        o.price_promo_cents,
        o.price_member_cents,
        o.comparative,
        o.promotion_data,
        o.source_data,
        o.observed_at,
        pc.store_id,
        pc.retailer_id
      FROM offer_revisions o
      JOIN offer_identities oi ON oi.id = o.identity_id
      JOIN price_contexts pc ON pc.id = oi.context_id
      WHERE o.observed_at >= ? AND o.observed_at <= ?
    `;
    const params = [
      Number.isFinite(from) ? from : 0,
      Number.isFinite(to) && to !== Number.POSITIVE_INFINITY ? to : 9007199254740991,
    ];
    if (query.productId) {
      sql += ' AND oi.product_id = ?';
      params.push(query.productId);
    }
    if (query.storeId) {
      sql += ' AND pc.store_id = ?';
      params.push(query.storeId);
    }
    if (query.retailer) {
      sql += ' AND pc.retailer_id = ?';
      params.push(query.retailer);
    }
    sql += ' ORDER BY o.observed_at ASC, o.seq ASC';

    const rows = this.#db.prepare(sql).all(...params);
    const listingCache = new Map();
    const productCache = new Map();
    const storeCache = new Map();
    const observations = [];

    for (const row of rows) {
      const listingKey = row.context_id;
      if (!listingCache.has(listingKey)) {
        listingCache.set(listingKey, this.#listingState('specials', row.context_id, asOf));
      }
      const listing = listingCache.get(listingKey);

      const productKey = `${row.product_id}@${row.observed_at}`;
      let product;
      if (productCache.has(productKey)) {
        product = productCache.get(productKey);
      } else {
        const rev = this.#db.prepare(`
          SELECT data FROM product_revisions
          WHERE product_id = ? AND observed_at <= ?
          ORDER BY observed_at DESC, seq DESC LIMIT 1
        `).get(row.product_id, row.observed_at);
        product = rev ? JSON.parse(rev.data) : { id: row.product_id };
        productCache.set(productKey, product);
      }

      const storeKey = `${row.context_id}@${row.observed_at}`;
      let store;
      if (storeCache.has(storeKey)) {
        store = storeCache.get(storeKey);
      } else {
        const rev = this.#db.prepare(`
          SELECT data FROM store_revisions
          WHERE context_id = ? AND observed_at <= ?
          ORDER BY observed_at DESC, seq DESC LIMIT 1
        `).get(row.context_id, row.observed_at);
        store = rev
          ? JSON.parse(rev.data)
          : { id: row.store_id, retailer: row.retailer_id };
        storeCache.set(storeKey, store);
      }

      const price = { regularCents: row.price_regular_cents };
      if (row.price_promo_cents != null) price.promoCents = row.price_promo_cents;
      if (row.price_member_cents != null) price.memberCents = row.price_member_cents;
      if (row.comparative) {
        try { price.comparative = JSON.parse(row.comparative); } catch { /* ignore */ }
      }

      const observation = {
        product: structuredClone(product),
        store: structuredClone(store),
        price,
        observedAt: new Date(row.observed_at).toISOString(),
        source: JSON.parse(row.source_data || '{}'),
      };
      if (row.promotion_data) {
        try { observation.promotion = JSON.parse(row.promotion_data); } catch { /* ignore */ }
      }
      if (listing.known) {
        observation.isOnSpecial = listing.active.has(Number(row.identity_id));
        if (observation.isOnSpecial && listing.lastSeenAt) {
          observation.lastSeenAt = new Date(listing.lastSeenAt).toISOString();
        }
      }
      observations.push(observation);
    }

    return filterObservations(observations, query);
  }

  stats() {
    const count = (table) => Number(this.#db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);
    return {
      products: count('product_revisions'),
      stores: count('store_revisions'),
      offers: count('offer_revisions'),
      snapshots: count('listing_snapshots'),
      identities: count('offer_identities'),
      activeSpecials: count('active_special_offers'),
    };
  }

  /** Rebuild the flat product_listings read model from the authoritative tables. */
  rebuildListings() {
    // Latest display fields per product (from the newest product revision).
    const products = new Map();
    for (const row of this.#db.prepare(`
      SELECT pr.product_id AS id, pr.data AS data
      FROM latest_product_revisions lpr
      JOIN product_revisions pr ON pr.hash = lpr.hash
    `).all()) {
      try { products.set(row.id, JSON.parse(row.data)); } catch { /* skip bad row */ }
    }

    // Latest offer per product×retailer (round-robin winner = newest observation).
    const rows = this.#db.prepare(`
      WITH per AS (
        SELECT
          oi.product_id AS product_id,
          pc.retailer_id AS retailer,
          pc.store_id AS store_id,
          pc.store_name AS store_name,
          orv.price_regular_cents AS reg,
          orv.price_promo_cents AS promo,
          orv.price_member_cents AS mem,
          lor.observed_at AS seen,
          ROW_NUMBER() OVER (
            PARTITION BY oi.product_id, pc.retailer_id
            ORDER BY lor.observed_at DESC, orv.seq DESC
          ) AS r
        FROM latest_offer_revisions lor
        JOIN offer_identities oi ON oi.id = lor.identity_id
        JOIN price_contexts pc ON pc.id = oi.context_id
        JOIN offer_revisions orv ON orv.id = lor.revision_id
      )
      SELECT product_id, retailer, store_id, store_name, reg, promo, mem, seen
      FROM per WHERE r = 1
    `).all();

    this.#db.exec('BEGIN IMMEDIATE');
    try {
      this.#db.exec('DELETE FROM product_listings');
      for (const row of rows) {
        this.#writeListing({
          productId: row.product_id,
          retailer: row.retailer,
          product: products.get(row.product_id) || { id: row.product_id },
          storeId: row.store_id,
          storeName: row.store_name,
          currentCents: effectiveCents({
            regularCents: row.reg,
            promoCents: row.promo ?? undefined,
            memberCents: row.mem ?? undefined,
          }),
          regularCents: row.reg,
          lastSeen: Number(row.seen),
        });
      }
      this.#db.prepare(
        "INSERT OR REPLACE INTO _meta(key, value) VALUES('listings_built', ?)",
      ).run(new Date().toISOString());
      this.#db.exec('COMMIT');
    } catch (err) {
      try { this.#db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
    return rows.length;
  }

  /** Aggregate stats for the site's /stats view (indexed counts, no full scan). */
  summary() {
    const t = this.#db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM offer_revisions)          AS observations,
        (SELECT COUNT(*) FROM latest_product_revisions) AS products,
        (SELECT COUNT(*) FROM price_contexts)           AS stores,
        (SELECT MIN(observed_at) FROM offer_revisions)  AS earliest,
        (SELECT MAX(observed_at) FROM offer_revisions)  AS latest
    `).get();
    const iso = (ms) => (ms != null ? new Date(Number(ms)).toISOString() : null);
    const retailers = this.#db
      .prepare('SELECT DISTINCT retailer_id AS r FROM price_contexts ORDER BY retailer_id')
      .all()
      .map((row) => row.r)
      .filter(Boolean);
    return {
      totalObservations: Number(t.observations || 0),
      totalProducts: Number(t.products || 0),
      totalStores: Number(t.stores || 0),
      stores: this.storeList(),
      retailers,
      dateRange: { earliest: iso(t.earliest), latest: iso(t.latest) },
    };
  }

  /** Every collected store, from the columnar price_contexts table. */
  storeList() {
    return this.#db.prepare(`
      SELECT store_id AS id, store_name AS name, retailer_id AS retailer, region, address
      FROM price_contexts
      ORDER BY store_name
    `).all().map((row) => ({
      id: row.id,
      name: row.name || row.id,
      retailer: row.retailer,
      region: row.region || undefined,
      address: row.address || undefined,
    }));
  }

  /**
   * A page of products for the browse view, served from the flat read model.
   * Round-robins retailers newest-first (matching interleaveByRetailer) unless a
   * retailer filter is set, in which case it's newest-first within that retailer.
   */
  productListings({ retailer, query, limit = 42, offset = 0 } = {}) {
    const r = retailer ? String(retailer).trim().toLowerCase() : null;
    const q = query ? String(query).trim().toLowerCase().slice(0, 200) : null;
    const conds = [];
    const filterParams = [];
    if (r) { conds.push('retailer = ?'); filterParams.push(r); }
    if (q) { conds.push('instr(search_text, ?) > 0'); filterParams.push(q); }
    const whereSql = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const total = Number(this.#db
      .prepare(`SELECT COUNT(*) AS n FROM product_listings ${whereSql}`)
      .get(...filterParams).n);

    const lim = Math.min(Math.max(Number(limit) || 42, 1), 500);
    const off = Math.max(Number(offset) || 0, 0);
    const order = r ? 'ORDER BY last_seen DESC, product_id' : 'ORDER BY rr, retailer';
    const rows = this.#db.prepare(`
      WITH filtered AS (SELECT * FROM product_listings ${whereSql}),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY retailer ORDER BY last_seen DESC, product_id
        ) AS rr
        FROM filtered
      )
      SELECT * FROM ranked ${order} LIMIT ? OFFSET ?
    `).all(...filterParams, lim, off);

    const products = rows.map((row) => ({
      id: row.product_id,
      name: row.name,
      brand: row.brand || undefined,
      categories: row.category ? [row.category] : [],
      imageUrl: row.image_url || undefined,
      retailer: row.retailer,
      storeId: row.store_id || undefined,
      storeName: row.store_name || undefined,
      currentCents: row.current_cents != null ? Number(row.current_cents) : undefined,
      regularCents: row.regular_cents != null ? Number(row.regular_cents) : undefined,
      lastSeen: row.last_seen != null ? new Date(Number(row.last_seen)).toISOString() : undefined,
    }));
    return { products, total, offset: off, limit: lim };
  }

  /**
   * Currently-advertised specials, computed and bounded in SQL (top N by
   * discount) so the deal feed never materialises the whole archive. Returns
   * entries already in toAgentFeed's ongoingSales shape. Members-only prices
   * are treated as public here (site default policy).
   */
  advertisedSpecials({ freshWithinDays = 7, limit = 300, at } = {}) {
    const atMs = at ? Date.parse(at) : Date.now();
    const freshCutoff = atMs - freshWithinDays * DEAL_DAY_MS;
    const cap = Math.max(1, Math.min(Number(limit) || 300, 1000));
    const rows = this.#db.prepare(`
      SELECT
        oi.product_id, pc.retailer_id AS retailer, pc.store_id, pc.store_name,
        o.price_regular_cents AS reg, o.price_promo_cents AS promo, o.price_member_cents AS mem,
        o.promotion_data, o.observed_at, a.last_seen_at AS last_seen,
        pl.name, pl.brand, pl.gtin, pl.image_url
      FROM latest_offer_revisions lor
      JOIN offer_revisions o ON o.id = lor.revision_id
      JOIN offer_identities oi ON oi.id = lor.identity_id
      JOIN price_contexts pc ON pc.id = oi.context_id
      JOIN active_special_offers a
        ON a.identity_id = lor.identity_id AND a.context_id = oi.context_id
      LEFT JOIN product_listings pl
        ON pl.product_id = oi.product_id AND pl.retailer = pc.retailer_id
      WHERE o.price_promo_cents IS NOT NULL
        AND o.price_promo_cents < o.price_regular_cents
        AND o.promotion_data IS NOT NULL
        AND o.observed_at >= ?
      ORDER BY (o.price_regular_cents - o.price_promo_cents) * 1.0 / o.price_regular_cents DESC
      LIMIT ?
    `).all(freshCutoff, cap);

    const out = [];
    for (const row of rows) {
      let promotion;
      try { promotion = row.promotion_data ? JSON.parse(row.promotion_data) : undefined; } catch { /* skip */ }
      if (!promotion || !promotionActive(promotion, atMs)) continue;
      const current = effectiveCents({
        regularCents: row.reg,
        promoCents: row.promo ?? undefined,
        memberCents: row.mem ?? undefined,
      });
      const savePercent = row.reg > current
        ? Math.round(((row.reg - current) / row.reg) * 10000) / 100
        : promotion?.savePercent;
      out.push({
        productId: row.product_id,
        productName: row.name,
        brand: row.brand || undefined,
        gtin: row.gtin || undefined,
        storeId: row.store_id,
        storeName: row.store_name,
        retailer: row.retailer,
        currentCents: current,
        regularCents: row.reg,
        priceKind: 'promo',
        savePercent,
        observedAt: new Date(Number(row.last_seen ?? row.observed_at)).toISOString(),
        promotion,
        imageUrl: row.image_url || undefined,
      });
    }
    return out;
  }

  /**
   * Observations for offers with ≥2 revisions — the only ones that can be
   * history-backed sales. Bounded to changed offers, so calculateSales can run
   * without materialising the whole archive.
   */
  multiRevisionObservations() {
    // Fast exit while collection is young: if every offer has exactly one
    // revision (revisions == identities) none can be history-backed, so skip the
    // full GROUP BY scan.
    const counts = this.#db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM offer_revisions) AS revisions,
        (SELECT COUNT(*) FROM offer_identities) AS identities
    `).get();
    if (Number(counts.revisions) <= Number(counts.identities)) return [];

    const rows = this.#db.prepare(`
      WITH multi AS (
        SELECT identity_id FROM offer_revisions GROUP BY identity_id HAVING COUNT(*) >= 2
      )
      SELECT
        o.identity_id, oi.product_id, pc.retailer_id AS retailer, pc.store_id, pc.store_name,
        o.price_regular_cents AS reg, o.price_promo_cents AS promo, o.price_member_cents AS mem,
        o.promotion_data, o.observed_at, pl.name, pl.brand, pl.image_url
      FROM multi
      JOIN offer_revisions o ON o.identity_id = multi.identity_id
      JOIN offer_identities oi ON oi.id = o.identity_id
      JOIN price_contexts pc ON pc.id = oi.context_id
      LEFT JOIN product_listings pl ON pl.product_id = oi.product_id AND pl.retailer = pc.retailer_id
      ORDER BY o.identity_id, o.observed_at ASC, o.seq ASC
    `).all();

    return rows.map((row) => {
      let promotion;
      try { promotion = row.promotion_data ? JSON.parse(row.promotion_data) : undefined; } catch { /* skip */ }
      return {
        product: {
          id: row.product_id,
          name: row.name,
          brand: row.brand || undefined,
          images: row.image_url ? [row.image_url] : [],
        },
        store: { id: row.store_id, retailer: row.retailer, name: row.store_name },
        price: {
          regularCents: row.reg,
          ...(row.promo != null ? { promoCents: row.promo } : {}),
          ...(row.mem != null ? { memberCents: row.mem } : {}),
        },
        observedAt: new Date(Number(row.observed_at)).toISOString(),
        ...(promotion ? { promotion } : {}),
      };
    });
  }

  /** Map of productId → display image, for cheap deal-feed image backfill. */
  productImageMap() {
    const map = new Map();
    for (const row of this.#db
      .prepare('SELECT product_id, image_url FROM product_listings WHERE image_url IS NOT NULL')
      .all()) {
      if (!map.has(row.product_id)) map.set(row.product_id, row.image_url);
    }
    return map;
  }

  /**
   * Latest offer observation time (ms since epoch) for a price_contexts.store_id,
   * or null if this store has never been collected.
   */
  latestObservationMsForStore(storeId) {
    const id = String(storeId || '');
    if (!id) return null;
    const row = this.#db.prepare(`
      SELECT MAX(o.observed_at) AS latest
      FROM offer_revisions o
      JOIN offer_identities oi ON oi.id = o.identity_id
      JOIN price_contexts pc ON pc.id = oi.context_id
      WHERE pc.store_id = ?
    `).get(id);
    if (row?.latest == null) return null;
    return Number(row.latest);
  }

  close() {
    this.#db.close();
  }

  /**
   * Stream-import a v2 (or legacy observation) JSONL into this archive.
   * Does not load the whole file into one string.
   */
  async importJsonl(jsonlPath, options = {}) {
    const path = resolve(jsonlPath);
    const stream = createReadStream(path, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNo = 0;
    let imported = 0;
    let errors = 0;
    const batch = [];
    const batchSize = options.batchSize || 200;
    let snapshotScope = options.snapshotScope;

    const flush = async () => {
      if (batch.length === 0) return;
      const n = await this.append(batch, snapshotScope ? { snapshotScope } : {});
      imported += n;
      batch.length = 0;
    };

    // For migration, snapshots are already in the JSONL as records — ingest records directly.
    for await (const line of rl) {
      lineNo += 1;
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch (err) {
        errors += 1;
        if (options.strict) {
          throw new Error(`Invalid JSONL at ${path}:${lineNo}`, { cause: err });
        }
        continue;
      }

      try {
        if (record.version === 2 && record.type) {
          await this.#importV2Record(record);
          imported += 1;
        } else if (record.product && record.store && record.price && record.source) {
          batch.push(record);
          if (batch.length >= batchSize) await flush();
        } else {
          throw new TypeError('Unknown archive record');
        }
      } catch (err) {
        errors += 1;
        if (options.strict) {
          throw new Error(`Import failed at ${path}:${lineNo}: ${err.message}`, { cause: err });
        }
      }
    }
    await flush();

    this.#db.prepare(
      "INSERT OR REPLACE INTO _meta(key, value) VALUES('migrated_from', ?)",
    ).run(path);
    this.#db.prepare(
      "INSERT OR REPLACE INTO _meta(key, value) VALUES('migrated_at', ?)",
    ).run(new Date().toISOString());

    // v2 records are ingested field-by-field, so rebuild the flat read model once.
    this.rebuildListings();

    return { imported, errors, lines: lineNo, stats: this.stats() };
  }

  async #importV2Record(record) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      if (record.type === 'product') {
        if (!this.#stmts.productRevExists.get(record.hash)) {
          this.#ensureRetailer(record.productId.split(':')[0]);
          const seq = this.#allocSeq();
          const observedAt = Date.parse(record.observedAt);
          this.#stmts.insertProductRev.run(
            record.hash,
            record.productId,
            record.productId.split(':')[0],
            JSON.stringify(record.data),
            observedAt,
            seq,
          );
          this.#stmts.upsertLatestProduct.run(record.productId, record.hash, observedAt, seq);
        }
      } else if (record.type === 'store') {
        if (!this.#stmts.storeRevExists.get(record.hash)) {
          const store = { id: record.storeId, ...record.data };
          if (!store.retailer) store.retailer = record.storeId.split(':')[0];
          const contextId = this.#ensureContext(store);
          const seq = this.#allocSeq();
          const observedAt = Date.parse(record.observedAt);
          this.#stmts.insertStoreRev.run(
            record.hash,
            contextId,
            JSON.stringify(record.data),
            observedAt,
            seq,
          );
          this.#stmts.upsertLatestStore.run(contextId, record.hash, observedAt, seq);
        }
      } else if (record.type === 'offer') {
        const storeId = record.storeId;
        const contextId = this.#contextIdForStore(storeId);
        const { id: identityId } = this.#ensureIdentity(record.productId, contextId, storeId);
        const latest = this.#stmts.latestOffer.get(identityId);
        if (latest?.rev_hash !== record.hash) {
          const data = record.data || {};
          const price = data.price || {};
          const seq = this.#allocSeq();
          const observedAt = Date.parse(record.observedAt);
          this.#stmts.insertOfferRev.run(
            identityId,
            record.hash,
            price.regularCents != null ? price.regularCents : 0,
            price.promoCents != null ? price.promoCents : null,
            price.memberCents != null ? price.memberCents : null,
            price.comparative ? JSON.stringify(price.comparative) : null,
            data.promotion ? JSON.stringify(data.promotion) : null,
            JSON.stringify(data.source || {}),
            observedAt,
            seq,
          );
          const revisionId = Number(this.#stmts.lastInsert.get().id);
          this.#stmts.upsertLatestOffer.run(identityId, record.hash, revisionId, observedAt, seq);
        }
      } else if (record.type === 'snapshot') {
        const storeId = record.storeId;
        const contextId = this.#contextIdForStore(storeId);
        const scope = record.scope || 'specials';
        const observedAt = Date.parse(record.observedAt);
        const seq = this.#allocSeq();
        this.#stmts.insertSnapshot.run(
          contextId,
          scope,
          observedAt,
          record.offersHash || fingerprint([]),
          record.offerCount || 0,
          seq,
        );
        const snapshotId = Number(this.#stmts.lastInsert.get().id);

        const resolveIdentity = (offerId) => {
          const existing = this.#stmts.getIdentity.get(offerId);
          if (existing) return Number(existing.id);
          const parts = String(offerId).split('\u0000');
          const productId = parts[0];
          const storePart = parts[1] || storeId;
          this.#stmts.insertIdentity.run(offerId, productId, contextId);
          return Number(this.#stmts.lastInsert.get().id);
        };

        for (const offerId of record.added || []) {
          const identityId = resolveIdentity(offerId);
          this.#stmts.insertChange.run(snapshotId, identityId, 'added');
          this.#stmts.insertActive.run(contextId, scope, identityId, observedAt);
        }
        for (const offerId of record.removed || []) {
          const identityId = resolveIdentity(offerId);
          this.#stmts.insertChange.run(snapshotId, identityId, 'removed');
          this.#stmts.deleteActive.run(contextId, scope, identityId);
        }
      }
      this.#db.exec('COMMIT');
    } catch (err) {
      try { this.#db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw err;
    }
  }
}
