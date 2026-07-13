import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
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
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function observationKey(observation) {
  return [
    observation.product.id,
    observation.store.id,
    observation.observedAt,
    JSON.stringify(observation.price),
    observation.source.retailerProductId,
  ].join("\u0000");
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

function offerId(observation) {
  return `${observation.product.id}\u0000${observation.store.id}`;
}

function listingId(scope, storeId) {
  return `${scope}\u0000${storeId}`;
}

function eventTime(record) {
  return Date.parse(record.observedAt);
}

export class MemoryObservationRepository {
  #keys = new Set();
  #observations = [];

  async append(observations) {
    let added = 0;

    for (const observation of observations) {
      const key = observationKey(observation);
      if (this.#keys.has(key)) continue;

      this.#keys.add(key);
      this.#observations.push(structuredClone(observation));
      added += 1;
    }

    return added;
  }

  async query(query = {}) {
    return filterObservations(this.#observations, query);
  }

  async productHistory(productId) {
    const revisions = new Map();
    for (const observation of this.#observations) {
      if (observation.product.id !== productId) continue;
      const hash = fingerprint(observation.product);
      if (!revisions.has(hash)) {
        revisions.set(hash, {
          hash,
          observedAt: observation.observedAt,
          product: structuredClone(observation.product),
        });
      }
    }
    return [...revisions.values()].sort((left, right) =>
      Date.parse(left.observedAt) - Date.parse(right.observedAt),
    );
  }
}

/**
 * Change-only archive format (v2): product and store revisions are content
 * addressed, offer revisions hold prices, and daily listing snapshots hold
 * only added/removed offer IDs. This makes unchanged daily collections tiny.
 */
export class JsonlObservationRepository {
  #loaded = false;
  #records = [];
  #productRevisions = new Map();
  #storeRevisions = new Map();
  #offerRevisions = new Map();
  #snapshots = new Map();
  #latestProduct = new Map();
  #latestStore = new Map();
  #latestOffer = new Map();
  #activeListings = new Map();

  #hasRevision(type, id, hash) {
    const revisions = type === "product"
      ? this.#productRevisions.get(id)
      : this.#storeRevisions.get(id);
    return revisions?.some((revision) => revision.hash === hash) ?? false;
  }

  constructor(filePath = "data/prices.jsonl") {
    this.filePath = resolve(filePath);
  }

  #push(record) {
    this.#records.push(record);

    if (record.type === "product") {
      const revisions = this.#productRevisions.get(record.productId) ?? [];
      revisions.push(record);
      this.#productRevisions.set(record.productId, revisions);
      this.#latestProduct.set(record.productId, record);
      return;
    }
    if (record.type === "store") {
      const revisions = this.#storeRevisions.get(record.storeId) ?? [];
      revisions.push(record);
      this.#storeRevisions.set(record.storeId, revisions);
      this.#latestStore.set(record.storeId, record);
      return;
    }
    if (record.type === "offer") {
      const revisions = this.#offerRevisions.get(record.offerId) ?? [];
      revisions.push(record);
      this.#offerRevisions.set(record.offerId, revisions);
      this.#latestOffer.set(record.offerId, record);
      return;
    }
    if (record.type === "snapshot") {
      const id = listingId(record.scope, record.storeId);
      const snapshots = this.#snapshots.get(id) ?? [];
      snapshots.push(record);
      this.#snapshots.set(id, snapshots);
      const active = this.#activeListings.get(id) ?? new Set();
      for (const idToAdd of record.added) active.add(idToAdd);
      for (const idToRemove of record.removed) active.delete(idToRemove);
      this.#activeListings.set(id, active);
    }
  }

  #productRecord(observation) {
    const hash = fingerprint(observation.product);
    const previous = this.#latestProduct.get(observation.product.id);
    if (previous?.hash === hash || this.#hasRevision("product", observation.product.id, hash)) {
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

  #storeRecord(observation) {
    const hash = fingerprint(observation.store);
    const previous = this.#latestStore.get(observation.store.id);
    if (previous?.hash === hash || this.#hasRevision("store", observation.store.id, hash)) {
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

  #offerRecord(observation) {
    const id = offerId(observation);
    const data = {
      price: structuredClone(observation.price),
      ...(observation.promotion ? { promotion: structuredClone(observation.promotion) } : {}),
      source: structuredClone(observation.source),
    };
    const hash = fingerprint(data);
    const previous = this.#latestOffer.get(id);
    if (previous?.hash === hash) return undefined;
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

  #snapshotRecord(scope, storeId, observedAt, currentOfferIds) {
    const id = listingId(scope, storeId);
    const previous = this.#activeListings.get(id) ?? new Set();
    const added = [...currentOfferIds].filter((value) => !previous.has(value)).sort();
    const removed = [...previous].filter((value) => !currentOfferIds.has(value)).sort();
    const offers = [...currentOfferIds]
      .sort()
      .map((id) => [id, this.#latestOffer.get(id)?.hash]);
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

  #ingest(observations, options = {}) {
    const additions = [];
    const listings = new Map();

    for (const observation of observations) {
      const product = this.#productRecord(observation);
      if (product) {
        this.#push(product);
        additions.push(product);
      }
      const store = this.#storeRecord(observation);
      if (store) {
        this.#push(store);
        additions.push(store);
      }
      const offer = this.#offerRecord(observation);
      if (offer) {
        this.#push(offer);
        additions.push(offer);
      }

      if (options.snapshotScope) {
        const current = listings.get(observation.store.id) ?? {
          observedAt: observation.observedAt,
          offerIds: new Set(),
        };
        current.offerIds.add(offerId(observation));
        listings.set(observation.store.id, current);
      }
    }

    for (const [storeId, listing] of listings) {
      const snapshot = this.#snapshotRecord(
        options.snapshotScope,
        storeId,
        listing.observedAt,
        listing.offerIds,
      );
      this.#push(snapshot);
      additions.push(snapshot);
    }
    return additions;
  }

  async #load() {
    if (this.#loaded) return;
    let contents = "";
    try {
      contents = await readFile(this.filePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    for (const [index, line] of contents.split("\n").entries()) {
      if (!line.trim()) continue;
      try {
        const record = JSON.parse(line);
        if (record.version === 2 && record.type) {
          this.#push(record);
        } else if (record.product && record.store && record.price && record.source) {
          // Legacy observations are accepted and projected into v2 in memory.
          this.#ingest([record]);
        } else {
          throw new TypeError("Unknown archive record");
        }
      } catch (error) {
        throw new Error(`Invalid JSONL at ${this.filePath}:${index + 1}`, { cause: error });
      }
    }
    this.#loaded = true;
  }

  #revisionAt(revisions, at) {
    for (let index = revisions.length - 1; index >= 0; index -= 1) {
      if (eventTime(revisions[index]) <= at) return revisions[index];
    }
    return revisions[0];
  }

  #listingState(scope, storeId, at) {
    const snapshots = this.#snapshots.get(listingId(scope, storeId)) ?? [];
    const active = new Set();
    let lastSeenAt;
    let known = false;
    for (const snapshot of snapshots) {
      if (eventTime(snapshot) > at) break;
      known = true;
      for (const id of snapshot.added) active.add(id);
      for (const id of snapshot.removed) active.delete(id);
      lastSeenAt = snapshot.observedAt;
    }
    return { active, lastSeenAt, known };
  }

  async append(observations, options = {}) {
    await this.#load();
    const additions = this.#ingest(observations, options);
    if (additions.length > 0) {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, additions.map((record) => JSON.stringify(record)).join("\n") + "\n");
    }
    return additions.length;
  }

  async compact() {
    await this.#load();
    const productRevisions = new Set();
    const storeRevisions = new Set();
    const snapshots = new Set();
    const compacted = this.#records.filter((record) => {
      if (record.type === "product") {
        const key = `${record.productId}\u0000${record.hash}`;
        if (productRevisions.has(key)) return false;
        productRevisions.add(key);
      }
      if (record.type === "store") {
        const key = `${record.storeId}\u0000${record.hash}`;
        if (storeRevisions.has(key)) return false;
        storeRevisions.add(key);
      }
      if (record.type === "snapshot") {
        const key = [record.scope, record.storeId, record.observedAt, record.offersHash].join("\u0000");
        if (snapshots.has(key)) return false;
        snapshots.add(key);
      }
      return true;
    });
    this.#records = compacted;
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(
      this.filePath,
      this.#records.map((record) => JSON.stringify(record)).join("\n") + (this.#records.length ? "\n" : ""),
    );
    return { records: this.#records.length, file: this.filePath };
  }

  async productHistory(productId) {
    await this.#load();
    return (this.#productRevisions.get(productId) ?? []).map((record) => ({
      hash: record.hash,
      observedAt: record.observedAt,
      product: structuredClone(record.data),
    }));
  }

  async query(query = {}) {
    await this.#load();
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

    for (const revisions of this.#offerRevisions.values()) {
      for (const offer of revisions) {
        const timestamp = eventTime(offer);
        if (timestamp < from || timestamp > to) continue;
        const listing = listingFor(offer.storeId);
        const displayAt = listing.active.has(offer.offerId) && listing.lastSeenAt
          ? Date.parse(listing.lastSeenAt)
          : timestamp;
        const product = this.#revisionAt(this.#productRevisions.get(offer.productId) ?? [], displayAt);
        const store = this.#revisionAt(this.#storeRevisions.get(offer.storeId) ?? [], displayAt);
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
}
