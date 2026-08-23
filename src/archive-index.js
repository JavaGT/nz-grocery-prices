import { fingerprint, validateRecordEnvelope } from "./archive-records.js";

/**
 * Dedup identity of an observation within a batch/repository (memory-only
 * repositories): everything that makes one observation distinct from another.
 */
function observationKey(observation) {
  return [
    observation.product.id,
    observation.store.id,
    observation.observedAt,
    JSON.stringify(observation.price),
    observation.source.retailerProductId,
  ].join("\u0000");
}

/**
 * Shared observation filtering: predicate match on productId/storeId/
 * retailer plus an inclusive [from, to] window on observedAt, then stable
 * sort by observedAt ascending and a structuredClone so callers can never
 * mutate index state. Used by every query path (JSONL, memory).
 */
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

/** Offer identity: one product at one store. */
function offerId(observation) {
  return `${observation.product.id}\u0000${observation.store.id}`;
}

/** Listing identity: a snapshot scope (e.g. "specials") at one store. */
function listingId(scope, storeId) {
  return `${scope}\u0000${storeId}`;
}

function eventTime(record) {
  return Date.parse(record.observedAt);
}

function insertChronologically(records, record) {
  const timestamp = eventTime(record);
  let index = records.length;
  while (index > 0 && eventTime(records[index - 1]) > timestamp) index -= 1;
  records.splice(index, 0, record);
}

function listingStateAt(snapshots, at = Number.POSITIVE_INFINITY) {
  const active = new Set();
  let lastSeenAt;
  let known = false;
  for (const snapshot of snapshots) {
    if (eventTime(snapshot) > at) continue;
    known = true;
    for (const offerIdValue of snapshot.added) active.add(offerIdValue);
    for (const offerIdValue of snapshot.removed) active.delete(offerIdValue);
  }
  if (known) lastSeenAt = snapshots
    .filter((snapshot) => eventTime(snapshot) <= at)
    .at(-1)?.observedAt;
  return { active, lastSeenAt, known };
}

function revisionAt(revisions, at) {
  for (let index = revisions.length - 1; index >= 0; index -= 1) {
    if (eventTime(revisions[index]) <= at) return revisions[index];
  }
  return undefined;
}

/**
 * In-memory projection of the archive: content-addressed product/store/offer
 * revisions, daily listing snapshots, and observation materialization.
 *
 * ORDERING INVARIANT [SOL-7/GROK-7]: per-entity revision and snapshot arrays
 * are chronological. Equal timestamps retain application order as the stable
 * tie-break. Historical lookups must not depend on archive line arrival order.
 *
 * No filesystem knowledge lives here: durability (writer/load protocols)
 * belongs to JsonlObservationRepository, which applies decoded records via
 * apply()/applyAdditions() and plans writes through draft()/planAppend().
 */
export class ArchiveIndex {
  // Records are never mutated after creation, so draft() can safely share
  // them while copying the surrounding structure.
  #index = {
    records: [],
    productRevisions: new Map(),
    storeRevisions: new Map(),
    offerRevisions: new Map(),
    snapshots: new Map(),
    offerIdsByProduct: new Map(),
    offerIdsByStore: new Map(),
    latestProduct: new Map(),
    latestStore: new Map(),
    latestOffer: new Map(),
  };

  /** Every applied record, in application order. Treat as immutable. */
  getRecords() {
    return structuredClone(this.#index.records);
  }

  /** Internal repository access; callers must not mutate returned records. */
  getRecordReferences() {
    return this.#index.records;
  }

  /** Discards all indexed state. */
  clear() {
    this.#index = {
      records: [],
      productRevisions: new Map(),
      storeRevisions: new Map(),
      offerRevisions: new Map(),
      snapshots: new Map(),
      offerIdsByProduct: new Map(),
      offerIdsByStore: new Map(),
      latestProduct: new Map(),
      latestStore: new Map(),
      latestOffer: new Map(),
    };
  }

  #hasRevision(type, id, hash, index = this.#index) {
    const revisions = type === "product"
      ? index.productRevisions.get(id)
      : index.storeRevisions.get(id);
    return revisions?.some((revision) => revision.hash === hash) ?? false;
  }

  #validateRecord(record) {
    const problems = validateRecordEnvelope(record);
    if (problems.length > 0) {
      throw new TypeError(`Invalid archive record: ${problems.join("; ")}`);
    }
    if (!Number.isFinite(eventTime(record))) {
      throw new TypeError("Invalid archive record: observedAt must be a valid ISO timestamp");
    }
    if (["product", "store", "offer"].includes(record.type) &&
        (!record.data || typeof record.data !== "object" || Array.isArray(record.data))) {
      throw new TypeError(`Invalid archive record: ${record.type} data must be an object`);
    }
    if (record.type === "product" && record.data.id !== record.productId) {
      throw new TypeError("Invalid archive record: product data.id must match productId");
    }
    if (record.type === "store" && record.data.id !== record.storeId) {
      throw new TypeError("Invalid archive record: store data.id must match storeId");
    }
    if (record.type === "offer") {
      if (!record.data.price || typeof record.data.price !== "object" ||
          !record.data.source || typeof record.data.source !== "object") {
        throw new TypeError("Invalid archive record: offer data must contain price and source");
      }
    }
    if (record.type === "snapshot" &&
        (!Array.isArray(record.added) || !Array.isArray(record.removed) ||
         record.added.some((value) => typeof value !== "string") ||
         record.removed.some((value) => typeof value !== "string"))) {
      throw new TypeError("Invalid archive record: snapshot added and removed must be string arrays");
    }
  }

  /**
   * Whether a product/store revision with exactly this content hash has
   * already been applied (archive dedup identity).
   */
  hasRevision(type, id, hash) {
    return this.#hasRevision(type, id, hash);
  }

  /** Applies one record to `index` (the live state or a planning draft). */
  #applyRecord(index, record) {
    index.records.push(record);

    if (record.type === "product") {
      const revisions = index.productRevisions.get(record.productId) ?? [];
      insertChronologically(revisions, record);
      index.productRevisions.set(record.productId, revisions);
      index.latestProduct.set(record.productId, revisions.at(-1));
      return;
    }
    if (record.type === "store") {
      const revisions = index.storeRevisions.get(record.storeId) ?? [];
      insertChronologically(revisions, record);
      index.storeRevisions.set(record.storeId, revisions);
      index.latestStore.set(record.storeId, revisions.at(-1));
      return;
    }
    if (record.type === "offer") {
      const revisions = index.offerRevisions.get(record.offerId) ?? [];
      insertChronologically(revisions, record);
      index.offerRevisions.set(record.offerId, revisions);
      index.latestOffer.set(record.offerId, revisions.at(-1));
      const productOffers = index.offerIdsByProduct.get(record.productId) ?? new Set();
      productOffers.add(record.offerId);
      index.offerIdsByProduct.set(record.productId, productOffers);
      const storeOffers = index.offerIdsByStore.get(record.storeId) ?? new Set();
      storeOffers.add(record.offerId);
      index.offerIdsByStore.set(record.storeId, storeOffers);
      return;
    }
    if (record.type === "snapshot") {
      const id = listingId(record.scope, record.storeId);
      const snapshots = index.snapshots.get(id) ?? [];
      insertChronologically(snapshots, record);
      index.snapshots.set(id, snapshots);
    }
  }

  /** Indexes one record into live state. */
  apply(record) {
    this.#validateRecord(record);
    this.#applyRecord(this.#index, structuredClone(record));
  }

  /** Bulk-apply decoded records (e.g. the additions of one append batch). */
  applyAdditions(records) {
    for (const record of records) this.#validateRecord(record);
    for (const record of records) this.#applyRecord(this.#index, structuredClone(record));
  }

  /** Shallow structural copy of the index; record objects are shared. */
  draft() {
    const copyAll = (map) =>
      new Map([...map].map(([key, value]) => [key, [...value]]));
    return {
      records: [...this.#index.records],
      productRevisions: copyAll(this.#index.productRevisions),
      storeRevisions: copyAll(this.#index.storeRevisions),
      offerRevisions: copyAll(this.#index.offerRevisions),
      snapshots: copyAll(this.#index.snapshots),
      offerIdsByProduct: new Map(
        [...this.#index.offerIdsByProduct].map(([key, value]) => [key, new Set(value)]),
      ),
      offerIdsByStore: new Map(
        [...this.#index.offerIdsByStore].map(([key, value]) => [key, new Set(value)]),
      ),
      latestProduct: new Map(this.#index.latestProduct),
      latestStore: new Map(this.#index.latestStore),
      latestOffer: new Map(this.#index.latestOffer),
    };
  }

  // ---- pure planning ----

  #planProductRecord(index, observation) {
    const hash = fingerprint(observation.product);
    const previous = index.latestProduct.get(observation.product.id);
    if (previous?.hash === hash || this.#hasRevision("product", observation.product.id, hash, index)) {
      return undefined;
    }
    return {
      version: 2,
      type: "product",
      productId: observation.product.id,
      hash,
      observedAt: observation.observedAt,
      data: structuredClone(observation.product),
    };
  }

  #planStoreRecord(index, observation) {
    const hash = fingerprint(observation.store);
    const previous = index.latestStore.get(observation.store.id);
    if (previous?.hash === hash || this.#hasRevision("store", observation.store.id, hash, index)) {
      return undefined;
    }
    return {
      version: 2,
      type: "store",
      storeId: observation.store.id,
      hash,
      observedAt: observation.observedAt,
      data: structuredClone(observation.store),
    };
  }

  #planOfferRecord(index, observation) {
    const id = offerId(observation);
    const data = {
      price: structuredClone(observation.price),
      ...(observation.promotion ? { promotion: structuredClone(observation.promotion) } : {}),
      source: structuredClone(observation.source),
    };
    const hash = fingerprint(data);
    const revisions = index.offerRevisions.get(id) ?? [];
    if (revisions.some((revision) => revision.hash === hash)) return undefined;
    return {
      version: 2,
      type: "offer",
      offerId: id,
      productId: observation.product.id,
      storeId: observation.store.id,
      hash,
      observedAt: observation.observedAt,
      data,
    };
  }

  #planSnapshotRecord(index, scope, storeId, observedAt, currentOfferIds) {
    const id = listingId(scope, storeId);
    const previous = listingStateAt(index.snapshots.get(id) ?? [], Date.parse(observedAt)).active;
    const added = [...currentOfferIds].filter((value) => !previous.has(value)).sort();
    const removed = [...previous].filter((value) => !currentOfferIds.has(value)).sort();
    const offers = [...currentOfferIds]
      .sort()
      .map((id) => [
        id,
        revisionAt(index.offerRevisions.get(id) ?? [], Date.parse(observedAt))?.hash,
      ]);
    return {
      version: 2,
      type: "snapshot",
      scope,
      storeId,
      observedAt,
      offerCount: currentOfferIds.size,
      offersHash: fingerprint(offers),
      added,
      removed,
    };
  }

  /**
   * PURE: computes the records `observations` would add, against a draft
   * copy of the index. Never touches live state, so a persist failure
   * leaves memory untouched by the UNAPPLIED plan; the caller then resets
   * state so the next operation reloads disk truth — if bytes did land,
   * the torn-tail policy blocks appends and points at repair.
   */
  planAppend(observations, options = {}) {
    const draft = this.draft();
    const additions = [];
    const listings = new Map();

    for (const observation of observations) {
      const product = this.#planProductRecord(draft, observation);
      if (product) {
        this.#applyRecord(draft, product);
        additions.push(product);
      }
      const store = this.#planStoreRecord(draft, observation);
      if (store) {
        this.#applyRecord(draft, store);
        additions.push(store);
      }
      const offer = this.#planOfferRecord(draft, observation);
      if (offer) {
        this.#applyRecord(draft, offer);
        additions.push(offer);
      }

      if (options.snapshotScope) {
        const current = listings.get(observation.store.id) ?? {
          observedAt: observation.observedAt,
          offerIds: new Set(),
        };
        if (Date.parse(observation.observedAt) > Date.parse(current.observedAt)) {
          current.observedAt = observation.observedAt;
        }
        current.offerIds.add(offerId(observation));
        listings.set(observation.store.id, current);
      }
    }

    for (const [storeId, listing] of listings) {
      const existing = draft.snapshots.get(listingId(options.snapshotScope, storeId)) ?? [];
      const latest = existing.at(-1);
      if (latest && Date.parse(listing.observedAt) < eventTime(latest)) {
        throw new Error(
          `Snapshot for ${storeId} is older than the latest archived snapshot; ` +
          "append snapshots chronologically or rebuild the archive",
        );
      }
      const snapshot = this.#planSnapshotRecord(
        draft,
        options.snapshotScope,
        storeId,
        listing.observedAt,
        listing.offerIds,
      );
      additions.push(snapshot);
    }
    return additions;
  }

  // ---- queries ----

  #listingState(scope, storeId, at) {
    const snapshots = this.#index.snapshots.get(listingId(scope, storeId)) ?? [];
    return listingStateAt(snapshots, at);
  }

  async productHistory(productId) {
    return (this.#index.productRevisions.get(productId) ?? []).map((record) => ({
      hash: record.hash,
      observedAt: record.observedAt,
      product: structuredClone(record.data),
    }));
  }

  /**
   * Materializes observations from offer revisions: each offer renders with
   * the product/store revisions in effect at its DISPLAY time — the
   * snapshot listing's lastSeenAt when listed under `scope: "specials"`,
   * otherwise its own observedAt — so retailer comes from the HISTORICAL
   * store revision, never the latest one. Unlisted offers (removed from the
   * listing) carry isOnSpecial: false; unknown-listing stores carry no
   * listing fields at all.
   */
  async query(query = {}) {
    const from = query.from ? Date.parse(query.from) : Number.NEGATIVE_INFINITY;
    const to = query.to ? Date.parse(query.to) : Number.POSITIVE_INFINITY;
    const asOf = Number.isFinite(to) ? to : Date.now();
    const listingStates = new Map();
    const listingFor = (storeId) => {
      if (!listingStates.has(storeId)) {
        listingStates.set(storeId, this.#listingState("specials", storeId, asOf));
      }
      return listingStates.get(storeId);
    };
    const observations = [];

    let candidateRevisions;
    if (query.productId && query.storeId) {
      const productOffers = this.#index.offerIdsByProduct.get(query.productId) ?? new Set();
      const storeOffers = this.#index.offerIdsByStore.get(query.storeId) ?? new Set();
      candidateRevisions = [...productOffers]
        .filter((offerIdValue) => storeOffers.has(offerIdValue))
        .map((offerIdValue) => this.#index.offerRevisions.get(offerIdValue) ?? []);
    } else if (query.productId) {
      candidateRevisions = [...(this.#index.offerIdsByProduct.get(query.productId) ?? [])]
        .map((offerIdValue) => this.#index.offerRevisions.get(offerIdValue) ?? []);
    } else if (query.storeId) {
      candidateRevisions = [...(this.#index.offerIdsByStore.get(query.storeId) ?? [])]
        .map((offerIdValue) => this.#index.offerRevisions.get(offerIdValue) ?? []);
    } else {
      candidateRevisions = this.#index.offerRevisions.values();
    }

    for (const revisions of candidateRevisions) {
      for (const offer of revisions) {
        const timestamp = eventTime(offer);
        if (timestamp < from || timestamp > to) continue;
        const listing = listingFor(offer.storeId);
        const displayAt = listing.active.has(offer.offerId) && listing.lastSeenAt
          ? Date.parse(listing.lastSeenAt)
          : timestamp;
        const product = revisionAt(this.#index.productRevisions.get(offer.productId) ?? [], displayAt);
        const store = revisionAt(this.#index.storeRevisions.get(offer.storeId) ?? [], displayAt);
        if (!product || !store) continue;
        if (query.productId && offer.productId !== query.productId) continue;
        if (query.storeId && offer.storeId !== query.storeId) continue;
        if (query.retailer && store.data.retailer !== query.retailer) continue;
        observations.push({
          product: structuredClone(product.data),
          store: structuredClone(store.data),
          price: structuredClone(offer.data.price),
          ...(offer.data.promotion ? { promotion: structuredClone(offer.data.promotion) } : {}),
          observedAt: offer.observedAt,
          ...(listing.known
            ? listing.active.has(offer.offerId)
              ? { lastSeenAt: listing.lastSeenAt, isOnSpecial: true }
              : { isOnSpecial: false }
            : {}),
          source: structuredClone(offer.data.source),
        });
      }
    }
    return filterObservations(observations, query);
  }

  /**
   * Summary of indexed state: record counts by type, distinct retailers
   * across the LATEST store revisions, and the observedAt span of every
   * record. Null dates when empty.
   */
  stats() {
    const counts = { product: 0, store: 0, offer: 0, snapshot: 0 };
    let firstTime = Number.POSITIVE_INFINITY;
    let lastTime = Number.NEGATIVE_INFINITY;
    let firstObservedAt = null;
    let lastObservedAt = null;
    for (const record of this.#index.records) {
      counts[record.type] += 1;
      const time = eventTime(record);
      if (time < firstTime) {
        firstTime = time;
        firstObservedAt = record.observedAt;
      }
      if (time > lastTime) {
        lastTime = time;
        lastObservedAt = record.observedAt;
      }
    }
    const retailers = [
      ...new Set(
        [...this.#index.latestStore.values()].map((record) => record.data.retailer),
      ),
    ].sort();
    return {
      records: counts,
      retailers,
      firstObservedAt: firstObservedAt ?? null,
      lastObservedAt: lastObservedAt ?? null,
    };
  }
}

export { filterObservations, observationKey };
