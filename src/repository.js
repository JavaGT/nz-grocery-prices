import { mkdir, open, rename, rm, rmdir, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  classifyParsedRecord,
  encodeRecord,
  fingerprint,
  offerRevisionHash,
  productRevisionHash,
  storeRevisionHash,
} from "./archive-records.js";
import { validateObservation } from "./domain/observation.js";

/**
 * Append-boundary validation: every observation entering a repository must
 * satisfy the canonical domain rules. Throws TypeError naming the index of
 * the first invalid observation and all of its problems. Adapters keep
 * returning `undefined` for incomplete rows — this check is for what actually
 * reaches the repository.
 */
function assertValidObservations(observations) {
  for (const [index, observation] of observations.entries()) {
    const problems = validateObservation(observation);
    if (problems.length > 0) {
      throw new TypeError(
        `Invalid observation at index ${index}: ${problems.join("; ")}`,
      );
    }
  }
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
    assertValidObservations(observations);
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
 *
 * Writer protocol (all mutations):
 *   acquire `<archive>.lock` (mkdir-based, cross-process) → re-stat the file
 *   and reload if it changed on disk → plan additions PURELY against a
 *   draft index → persist (append: open('a') + write + fh.sync(); rewrite:
 *   temp file + fh.sync() + atomic rename + parent-dir fsync) → only then
 *   apply the additions to in-memory state. In-process callers queue behind
 *   one promise chain.
 *
 * Durability honesty: fh.sync() is fsync(2). On APFS that is not
 * F_FULLFSYNC — this buys crash-atomicity and torn-tail recovery, NOT
 * guaranteed power-loss durability.
 *
 * Load protocol: chunked streaming read that knows whether the final byte
 * was a newline. Terminated-but-invalid lines are hard errors naming
 * filePath:lineNumber; an undecodable unterminated tail sets a torn-tail
 * flag that blocks appends/compaction until repair; a decodable one is
 * recovered as a record. Stored hashes are re-verified against recomputed
 * fingerprints on load — mismatches are collected as defects (see
 * getLoadDefects()), never fatal.
 */
export class JsonlObservationRepository {
  // Mutable archive index. Records are never mutated after creation, so the
  // planner can safely share them with a draft copy of this structure.
  #index = {
    records: [],
    productRevisions: new Map(),
    storeRevisions: new Map(),
    offerRevisions: new Map(),
    snapshots: new Map(),
    latestProduct: new Map(),
    latestStore: new Map(),
    latestOffer: new Map(),
    activeListings: new Map(),
  };
  #loaded = false;
  #lockPath;
  // Stat signature captured when the file was loaded; a mismatch under the
  // lock means another writer touched the file and we must reload.
  #fileSignature = null;
  // Whether the loaded file's final byte was "\n"; guards against gluing a
  // recovered unterminated tail to the next append.
  #endsWithNewline = true;
  // Set when the archive ends in bytes that could not be decoded as a
  // record (a torn tail from a mid-write crash). Appends and compaction
  // refuse until repair/truncation, so a bad fragment is never glued into
  // a "valid" line.
  #tornTail = false;
  // Hash mismatches found while loading (stored hash ≠ recomputed
  // fingerprint of the payload). Non-fatal: surfaced via getLoadDefects().
  #loadDefects = [];
  // Serializes mutations in this process behind one promise chain.
  #queue = Promise.resolve();

  constructor(filePath = "data/prices.jsonl") {
    this.filePath = resolve(filePath);
    this.#lockPath = `${this.filePath}.lock`;
  }

  /**
   * Hash mismatches collected during the most recent load: stored record
   * hashes that did not match the recomputed fingerprint of the payload.
   * Queries stay available; repair (scripts/repair-archive.js) can rewrite
   * corrected hashes. Cleared on reload.
   */
  getLoadDefects() {
    return [...this.#loadDefects];
  }

  #hasRevision(type, id, hash, index = this.#index) {
    const revisions = type === "product"
      ? index.productRevisions.get(id)
      : index.storeRevisions.get(id);
    return revisions?.some((revision) => revision.hash === hash) ?? false;
  }

  /** Applies one record to `index` (the live state or a planning draft). */
  #applyRecord(index, record) {
    index.records.push(record);

    if (record.type === "product") {
      const revisions = index.productRevisions.get(record.productId) ?? [];
      revisions.push(record);
      index.productRevisions.set(record.productId, revisions);
      index.latestProduct.set(record.productId, record);
      return;
    }
    if (record.type === "store") {
      const revisions = index.storeRevisions.get(record.storeId) ?? [];
      revisions.push(record);
      index.storeRevisions.set(record.storeId, revisions);
      index.latestStore.set(record.storeId, record);
      return;
    }
    if (record.type === "offer") {
      const revisions = index.offerRevisions.get(record.offerId) ?? [];
      revisions.push(record);
      index.offerRevisions.set(record.offerId, revisions);
      index.latestOffer.set(record.offerId, record);
      return;
    }
    if (record.type === "snapshot") {
      const id = listingId(record.scope, record.storeId);
      const snapshots = index.snapshots.get(id) ?? [];
      snapshots.push(record);
      index.snapshots.set(id, snapshots);
      const active = index.activeListings.get(id) ?? new Set();
      for (const idToAdd of record.added) active.add(idToAdd);
      for (const idToRemove of record.removed) active.delete(idToRemove);
      index.activeListings.set(id, active);
    }
  }

  /** Shallow structural copy of the index; record objects are shared. */
  #draftIndex() {
    const copyAll = (map) =>
      new Map([...map].map(([key, value]) => [key, [...value]]));
    return {
      records: [...this.#index.records],
      productRevisions: copyAll(this.#index.productRevisions),
      storeRevisions: copyAll(this.#index.storeRevisions),
      offerRevisions: copyAll(this.#index.offerRevisions),
      snapshots: copyAll(this.#index.snapshots),
      latestProduct: new Map(this.#index.latestProduct),
      latestStore: new Map(this.#index.latestStore),
      latestOffer: new Map(this.#index.latestOffer),
      activeListings: new Map(
        [...this.#index.activeListings].map(([key, set]) => [key, new Set(set)]),
      ),
    };
  }

  // ---- locking ----

  /**
   * Cross-process exclusive lock: mkdir is atomic, so creating the lock
   * directory succeeds for exactly one writer. scripts/
   * archive-daily-local.sh takes the same lock while publishing.
   */
  async #acquireLock() {
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      await mkdir(this.#lockPath);
    } catch (error) {
      if (error.code === "EEXIST") {
        throw new Error(
          `Archive is locked by another writer (${this.#lockPath}). If no writer is running, remove the lock directory.`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  async #releaseLock() {
    // A failed unlock must not mask the operation's own outcome; a stale
    // lock directory is safe to remove manually.
    await rmdir(this.#lockPath).catch(() => {});
  }

  /** Runs `operation` holding the lock, serialized behind the queue. */
  async #withLock(operation) {
    const run = this.#queue.then(async () => {
      await this.#acquireLock();
      try {
        return await operation();
      } finally {
        await this.#releaseLock();
      }
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  // ---- durability ----

  /**
   * fsync the parent directory so a newly created file's directory entry
   * survives a crash. See the class comment for the APFS caveat.
   */
  async #fsyncParentDir() {
    const handle = await open(dirname(this.filePath), "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async #currentSignature() {
    try {
      const stats = await stat(this.filePath);
      return { mtimeMs: stats.mtimeMs, size: stats.size, ino: stats.ino };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  #signatureChanged(current) {
    if (current === null || this.#fileSignature === null) {
      return current !== this.#fileSignature;
    }
    return (
      current.ino !== this.#fileSignature.ino ||
      current.size !== this.#fileSignature.size ||
      current.mtimeMs !== this.#fileSignature.mtimeMs
    );
  }

  /** Discards every bit of in-memory archive state. */
  #resetState() {
    this.#index = {
      records: [],
      productRevisions: new Map(),
      storeRevisions: new Map(),
      offerRevisions: new Map(),
      snapshots: new Map(),
      latestProduct: new Map(),
      latestStore: new Map(),
      latestOffer: new Map(),
      activeListings: new Map(),
    };
    this.#loaded = false;
    this.#fileSignature = null;
    this.#endsWithNewline = true;
    this.#tornTail = false;
    this.#loadDefects = [];
  }

  /** Under the lock: reload from disk if the file changed since we loaded. */
  async #reloadIfChanged() {
    const signature = await this.#currentSignature();
    if (!this.#signatureChanged(signature)) return;
    this.#resetState();
    await this.#load();
  }

  // ---- loading ----

  /**
   * Chunked streaming read of the archive. Lines are split on "\n" across
   * chunk boundaries manually — readline cannot report whether the file's
   * final byte was a newline, and torn-tail policy needs to know. Returns
   * `{ line, terminated }` entries; `terminated` is false only for an
   * unterminated final fragment.
   */
  async #lines() {
    const handle = await open(this.filePath, "r");
    try {
      const lines = [];
      const stream = handle.createReadStream({ encoding: "utf8" });
      let pending = "";
      for await (const chunk of stream) {
        const pieces = chunk.split("\n");
        pending += pieces[0];
        for (let index = 1; index < pieces.length; index += 1) {
          lines.push({ line: pending, terminated: true });
          pending = pieces[index];
        }
      }
      // After a trailing newline `pending` is ""; otherwise it holds the
      // unterminated final fragment.
      if (pending !== "") lines.push({ line: pending, terminated: false });
      return lines;
    } finally {
      await handle.close();
    }
  }

  /**
   * Load protocol: stream line-by-line so torn tails are detectable.
   *
   * - Newline-terminated line failing decode → hard error naming
   *   filePath:lineNumber (even when it is the last line).
   * - Unterminated final bytes: JSON.parse success → recover as a record
   *   (a crash happened between write and newline); failure → set
   *   #tornTail and skip the fragment.
   * - Every loaded record passes classifyParsedRecord (envelope check);
   *   stored hashes are verified against recomputed fingerprints with
   *   mismatches collected into #loadDefects rather than aborting — the
   *   data still queries, getLoadDefects() surfaces the damage.
   * - Snapshot offersHash is deliberately NOT recomputed on load:
   *   deriving it requires replaying listing state across all prior
   *   snapshots, which is costly and fragile against mid-archive
   *   corruption. Dedup treats it as stored.
   */
  async #load() {
    if (this.#loaded) return;
    let exists = true;
    try {
      await stat(this.filePath);
    } catch (error) {
      if (error.code === "ENOENT") exists = false;
      else throw error;
    }

    // Only the final entry from #lines() can be unterminated; that fragment
    // is the torn tail. A terminated line must decode or the archive is
    // corrupt mid-file (or at EOF after a newline — equally fatal).
    if (!exists) {
      this.#fileSignature = await this.#currentSignature();
      this.#loaded = true;
      return;
    }

    const lines = await this.#lines();
    let lineNumber = 0;
    for (const entry of lines) {
      lineNumber += 1;
      const isTornFragment = !entry.terminated;
      let verdict;
      try {
        verdict = classifyParsedRecord(JSON.parse(entry.line));
      } catch (error) {
        if (isTornFragment) {
          this.#tornTail = true; // unparseable final bytes: skip, block appends
          break;
        }
        throw new Error(`Invalid JSONL at ${this.filePath}:${lineNumber}`, { cause: error });
      }
      if (verdict.status === "invalid") {
        if (isTornFragment) {
          this.#tornTail = true; // envelope-invalid fragment cannot be trusted
          break;
        }
        throw new Error(
          `Invalid archive record at ${this.filePath}:${lineNumber} (${verdict.problems.join("; ")})`,
        );
      }
      if (verdict.status === "legacy") {
        // Legacy observations are accepted and projected into v2 in memory.
        const additions = this.#planAppend([verdict.record]);
        for (const addition of additions) this.#applyRecord(this.#index, addition);
        continue;
      }

      const expectedHash =
        verdict.record.type === "product"
          ? productRevisionHash(verdict.record.data)
          : verdict.record.type === "store"
          ? storeRevisionHash(verdict.record.data)
          : offerRevisionHash(verdict.record.data);
      if (
        typeof verdict.record.hash === "string" &&
        verdict.record.hash !== expectedHash
      ) {
        this.#loadDefects.push({
          line: lineNumber,
          type: verdict.record.type,
          id: verdict.record.productId ?? verdict.record.storeId ?? verdict.record.offerId,
          stored: verdict.record.hash,
          recomputed: expectedHash,
        });
      }
      this.#applyRecord(this.#index, verdict.record);
    }
    if (!this.#tornTail && lines.length > 0 && !lines[lines.length - 1].terminated) {
      // A valid record recovered from an unterminated tail still means the
      // file lacks its closing newline; the next append must prepend one.
      this.#endsWithNewline = false;
    }
    this.#fileSignature = await this.#currentSignature();
    this.#loaded = true;
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
    const previous = index.latestOffer.get(id);
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

  #planSnapshotRecord(index, scope, storeId, observedAt, currentOfferIds) {
    const id = listingId(scope, storeId);
    const previous = index.activeListings.get(id) ?? new Set();
    const added = [...currentOfferIds].filter((value) => !previous.has(value)).sort();
    const removed = [...previous].filter((value) => !currentOfferIds.has(value)).sort();
    const offers = [...currentOfferIds]
      .sort()
      .map((id) => [id, index.latestOffer.get(id)?.hash]);
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
   * leaves memory untouched and a retry re-plans identically.
   */
  #planAppend(observations, options = {}) {
    const draft = this.#draftIndex();
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
        current.offerIds.add(offerId(observation));
        listings.set(observation.store.id, current);
      }
    }

    for (const [storeId, listing] of listings) {
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

  // ---- mutation (writer protocol) ----

  /**
   * Persists `additions` to the archive: open-append → write → fh.sync().
   * Prepends a newline separator when the file's tail lacked one so a
   * recovered unterminated record cannot glue to the batch. fsyncs the
   * parent directory only when this call created the file.
   */
  async #persistAdditions(additions) {
    const existed = this.#fileSignature !== null;
    await mkdir(dirname(this.filePath), { recursive: true });
    const separator = this.#endsWithNewline ? "" : "\n";
    const payload =
      separator + additions.map((record) => encodeRecord(record)).join("\n") + "\n";
    const handle = await open(this.filePath, "a");
    try {
      await handle.write(payload, null, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (!existed) await this.#fsyncParentDir();
  }

  async #appendLocked(observations, options) {
    await this.#reloadIfChanged();
    if (this.#tornTail) {
      throw new Error(
        `Archive ends in a torn (undecodable) tail; refusing to append. ` +
          `Repair first: node scripts/repair-archive.js --file ${this.filePath}`,
      );
    }
    const additions = this.#planAppend(observations, options);
    if (additions.length > 0) {
      await this.#persistAdditions(additions);
      for (const record of additions) this.#applyRecord(this.#index, record);
      this.#fileSignature = await this.#currentSignature();
      this.#endsWithNewline = true;
    }
    // Memory now matches the persisted file; mark loaded so queries never
    // re-read and re-apply the records we just applied (the duplication bug).
    this.#loaded = true;
    return additions.length;
  }

  /**
   * Validates, then (holding the lock) plans purely, persists durably, and
   * only then updates in-memory state. Returns the number of records added.
   */
  async append(observations, options = {}) {
    assertValidObservations(observations);
    return this.#withLock(() => this.#appendLocked(observations, options));
  }

  /**
   * Deduplicates repeated revisions/snapshots and atomically replaces the
   * archive via sibling-temp → fh.sync() → rename → parent-dir fsync. The
   * live path is never written in place, so readers of the old inode finish
   * safely and a crash leaves either the old or the new complete file.
   */
  async #compactLocked() {
    await this.#reloadIfChanged();
    if (this.#tornTail) {
      throw new Error(
        `Archive ends in a torn (undecodable) tail; refusing to compact. ` +
          `Repair first: node scripts/repair-archive.js --file ${this.filePath}`,
      );
    }
    const productRevisions = new Set();
    const storeRevisions = new Set();
    const snapshots = new Set();
    const compacted = this.#index.records.filter((record) => {
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

    const content =
      compacted.map((record) => encodeRecord(record)).join("\n") +
      (compacted.length ? "\n" : "");
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.compact-${process.pid}-${Date.now()}.tmp`;
    try {
      const handle = await open(tempPath, "w");
      try {
        await handle.write(content, null, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, this.filePath);
    } catch (error) {
      await rm(tempPath, { force: true });
      throw error;
    }
    await this.#fsyncParentDir();

    // Rebuild in-memory state from the compacted record set.
    this.#resetState();
    for (const record of compacted) this.#applyRecord(this.#index, record);
    this.#fileSignature = await this.#currentSignature();
    this.#loaded = true;
    return { records: this.#index.records.length, file: this.filePath };
  }

  compact() {
    return this.#withLock(() => this.#compactLocked());
  }

  // ---- queries ----

  #revisionAt(revisions, at) {
    for (let index = revisions.length - 1; index >= 0; index -= 1) {
      if (eventTime(revisions[index]) <= at) return revisions[index];
    }
    return revisions[0];
  }

  #listingState(scope, storeId, at) {
    const snapshots = this.#index.snapshots.get(listingId(scope, storeId)) ?? [];
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

  async productHistory(productId) {
    await this.#load();
    return (this.#index.productRevisions.get(productId) ?? []).map((record) => ({
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

    for (const revisions of this.#index.offerRevisions.values()) {
      for (const offer of revisions) {
        const timestamp = eventTime(offer);
        if (timestamp < from || timestamp > to) continue;
        const listing = listingFor(offer.storeId);
        const displayAt = listing.active.has(offer.offerId) && listing.lastSeenAt
          ? Date.parse(listing.lastSeenAt)
          : timestamp;
        const product = this.#revisionAt(this.#index.productRevisions.get(offer.productId) ?? [], displayAt);
        const store = this.#revisionAt(this.#index.storeRevisions.get(offer.storeId) ?? [], displayAt);
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
