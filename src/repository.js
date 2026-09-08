import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  classifyParsedRecord,
  cloneJson,
  encodeRecord,
  fingerprint,
  offerRevisionHash,
  productRevisionHash,
  storeRevisionHash,
} from "./archive-records.js";
import { ArchiveIndex, filterObservations, observationKey } from "./archive-index.js";
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

/** Recomputed content hash for a loaded record's payload. */
function revisionHashFor(record) {
  if (record.type === "product") return productRevisionHash(record.data);
  if (record.type === "store") return storeRevisionHash(record.data);
  if (record.type === "offer") return offerRevisionHash(record.data);
  // Snapshots carry offersHash over listing state, not a payload hash;
  // recomputing one requires replaying prior listing state (see
  // DECISIONLOG 2026-08-23) and is deliberately never done at load.
  return undefined;
}

/**
 * Chunked streaming read of a JSONL archive. Lines are split on "\n"
 * across chunk boundaries manually — readline cannot report whether the
 * file's final byte was a newline, and torn-tail policy needs to know.
 * Returns `{ line, terminated }` entries; `terminated` is false only for
 * an unterminated final fragment. Shared by the repository loader and the
 * repair CLI.
 */
async function readArchiveLines(filePath) {
  const handle = await open(filePath, "r");
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
 * Streaming twin of readArchiveLines: yields `{ line, terminated }` entries
 * one at a time (same manual "\n" split across chunk boundaries, same
 * `terminated` semantics) so the repository loader can decode and apply each
 * line WITHOUT holding the whole file's lines in memory at once. Blank lines
 * are yielded like any other; numbering and filtering stay with the caller.
 */
async function* iterateArchiveLines(filePath) {
  const handle = await open(filePath, "r");
  try {
    const stream = handle.createReadStream({ encoding: "utf8" });
    let pending = "";
    for await (const chunk of stream) {
      const pieces = chunk.split("\n");
      pending += pieces[0];
      for (let index = 1; index < pieces.length; index += 1) {
        yield { line: pending, terminated: true };
        pending = pieces[index];
      }
    }
    // After a trailing newline `pending` is ""; otherwise it holds the
    // unterminated final fragment.
    if (pending !== "") yield { line: pending, terminated: false };
  } finally {
    await handle.close();
  }
}

/**
 * Decodes and classifies one archive line — the single tolerance policy
 * shared by the repository loader, scripts/repair-archive.js, and the v1
 * migrator.
 *
 * Returns one of:
 *   { status: "v2", record, defect? } — envelope-valid v2 record; `defect`
 *     is set when the stored hash ≠ recomputed fingerprint (never fatal).
 *   { status: "legacy", record }      — v1 whole-observation. The loader
 *     REFUSES these post-CORE-6 (run scripts/migrate-v1-archive.js); repair
 *     keeps them byte-for-byte and the migrator converts them.
 *   { status: "torn" }                — undecodable UNTERMINATED final
 *     bytes; caller decides recovery vs quarantine.
 *
 * Throws an Error naming filePath:lineNumber for anything else, i.e. any
 * newline-terminated line that fails to decode or violates the envelope.
 */
function decodeArchiveLine(line, filePath, lineNumber, terminated) {
  let verdict;
  try {
    verdict = classifyParsedRecord(JSON.parse(line));
  } catch (error) {
    if (!terminated) return { status: "torn" };
    throw new Error(`Invalid JSONL at ${filePath}:${lineNumber}`, { cause: error });
  }
  if (verdict.status === "invalid") {
    if (!terminated) return { status: "torn" };
    throw new Error(
      `Invalid archive record at ${filePath}:${lineNumber} (${verdict.problems.join("; ")})`,
    );
  }
  if (verdict.status === "legacy") return verdict;

  const expectedHash = revisionHashFor(verdict.record);
  const defect =
    typeof expectedHash === "string" &&
    verdict.record.hash !== expectedHash
      ? {
          line: lineNumber,
          type: verdict.record.type,
          id: verdict.record.productId ?? verdict.record.storeId ?? verdict.record.offerId,
          stored: verdict.record.hash,
          recomputed: expectedHash,
        }
      : undefined;
  return { status: "v2", record: verdict.record, defect };
}

/**
 * Write EVERY byte of `payload` to `handle`.
 *
 * FileHandle.write() is allowed to resolve with bytesWritten < payload
 * length (short write), so a single write can silently drop a record
 * tail. This loops from the returned offset until the whole payload has
 * landed. Takes a string or Buffer; strings are encoded here so
 * partial-write offsets are BYTE offsets, not UTF-8 code-unit offsets.
 */
async function writeAll(handle, payload) {
  const buffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset);
    if (!Number.isInteger(bytesWritten) || bytesWritten <= 0) {
      throw new Error(
        `Archive write made no progress (bytesWritten=${bytesWritten} at offset ${offset})`,
      );
    }
    offset += bytesWritten;
  }
}

/**
 * writeAll, then fh.sync() it — only a fully-landed payload makes the
 * sync meaningful. Shared by the repository writer paths and
 * scripts/repair-archive.js.
 */
async function writeAllAndSync(handle, payload) {
  await writeAll(handle, payload);
  await handle.sync();
}

export { writeAllAndSync };

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
      this.#observations.push(cloneJson(observation));
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
          product: cloneJson(observation.product),
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
  // Mutable archive index (see ArchiveIndex). Records are never mutated
  // after creation, so the planner can safely share them with a draft copy.
  #index = new ArchiveIndex();
  #loaded = false;
  // Single-flight load promise: created by the first concurrent caller,
  // awaited by all of them, so records are applied exactly once no matter
  // how many first-queries race. Cleared by #resetState().
  #loadPromise = null;
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

  /** Chunked torn-tail-aware line reader (see readArchiveLines). */
  static async readArchiveLines(filePath) {
    return readArchiveLines(filePath);
  }

  /**
   * Shared line decode/tolerance policy (see decodeArchiveLine): the
   * repair CLI scans archives through this so quarantine decisions match
   * loader behavior exactly.
   */
  static decodeArchiveLine(line, filePath, lineNumber, terminated) {
    return decodeArchiveLine(line, filePath, lineNumber, terminated);
  }

  // ---- locking ----

  /**
   * Cross-process exclusive lock (see acquireArchiveLock): mkdir is
   * atomic, so creating the lock directory succeeds for exactly one
   * writer. A `pid` file inside names the holder so a crashed writer's
   * lock can be reclaimed. scripts/archive-daily-local.sh takes the same
   * lock while publishing and records its pid too.
   */
  #acquireLock() {
    return acquireArchiveLock(this.#lockPath);
  }

  async #releaseLock() {
    // A failed unlock must not mask the operation's own outcome; a stale
    // lock directory is reclaimed automatically via the pid file.
    await rm(this.#lockPath, { recursive: true, force: true }).catch(() => {});
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
    this.#index.clear();
    this.#loaded = false;
    this.#loadPromise = null;
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
   * Load protocol: stream line-by-line so torn tails are detectable.
   *
   * - Newline-terminated line failing decode \u2192 hard error naming
   *   filePath:lineNumber (even when it is the last line).
   * - Unterminated final bytes: decodes to a valid v2 record \u2192
   *   recover it (a crash happened between write and newline); anything
   *   else \u2192 set #tornTail and skip the fragment.
   * - A decoded LEGACY v1 record is a hard error naming file:line with
   *   the migrator command (CORE-6 cutover) — never silently projected.
   * - Stored hashes are verified against recomputed fingerprints with
   *   mismatches collected into #loadDefects rather than aborting \u2014
   *   data still queries, getLoadDefects() surfaces the damage.
   * - Snapshot offersHash is deliberately NOT recomputed on load:
   *   deriving it requires replaying listing state across all prior
   *   snapshots, which is costly and fragile against mid-archive
   *   corruption. Dedup treats it as stored.
   *
   * Line reading/classification lives in readArchiveLines +
   * decodeArchiveLine (module scope) so scripts/repair-archive.js reuses
   * identical semantics instead of duplicating them.
   */
  #load() {
    // Single flight: concurrent first callers share one load so records
    // cannot be applied twice.
    if (this.#loaded) return Promise.resolve();
    if (!this.#loadPromise) {
      this.#loadPromise = this.#loadUncached().catch((error) => {
        // A failed load can leave partially-applied state; reset so the
        // next caller starts from a clean slate instead of a half index.
        this.#resetState();
        throw error;
      });
    }
    return this.#loadPromise;
  }

  async #loadUncached() {
    let exists = true;
    try {
      await stat(this.filePath);
    } catch (error) {
      if (error.code === "ENOENT") exists = false;
      else throw error;
    }

    if (!exists) {
      this.#fileSignature = await this.#currentSignature();
      this.#loaded = true;
      return;
    }

    // Streamed decode: each line is classified and applied as the reader
    // yields it, so the loader never holds the whole file's lines in memory
    // (the accumulate-then-apply variant peaked at file size + wrappers).
    let lineNumber = 0;
    let lastTerminated = true;
    let sawLine = false;
    for await (const entry of iterateArchiveLines(this.filePath)) {
      lineNumber += 1;
      sawLine = true;
      lastTerminated = entry.terminated;
      if (entry.line.trim() === "") continue; // stray blank lines are not corruption
      const outcome = decodeArchiveLine(entry.line, this.filePath, lineNumber, entry.terminated);
      if (outcome.status === "torn") {
        this.#tornTail = true; // undecodable final bytes: skip, block appends
        break;
      }
      if (outcome.status === "legacy") {
        // Legacy v1 whole-observations are no longer projected (CORE-6
        // cutover): the one-shot migrator is their only handler, so the
        // normal repository can never silently reinterpret an old line.
        throw new Error(
          `Legacy v1 archive record at ${this.filePath}:${lineNumber}; ` +
            `run node scripts/migrate-v1-archive.js --file ${this.filePath} first`,
        );
      }
      if (outcome.defect) this.#loadDefects.push(outcome.defect);
      // Loader fast path: the decoded record is exclusively owned here
      // (fresh from JSON.parse, nobody else holds it), so it is indexed
      // without a per-record deep clone.
      this.#index.applyParsed(outcome.record);
    }
    if (!this.#tornTail && sawLine && !lastTerminated) {
      // A valid record recovered from an unterminated tail still means the
      // file lacks its closing newline; the next append must prepend one.
      this.#endsWithNewline = false;
    }
    this.#fileSignature = await this.#currentSignature();
    this.#loaded = true;
  }

  // ---- mutation (writer protocol) ----

  /**
   * Persists `additions` to the archive: open-append → write → fh.sync().
   * Prepends a newline separator when the file's tail lacked one so a
   * recovered unterminated record cannot glue to the batch. fsyncs the
   * parent directory only when this call created the file.
   */
  async #persistAdditions(additions) {
    // Decide "created" by statting the path IMMEDIATELY before open, not
    // from the cached load signature: the cache can be stale (external
    // delete/recreate, or a reset after a failed persist), and only a
    // true create needs the parent-dir fsync below for its directory
    // entry to survive a crash.
    let existed = true;
    try {
      await stat(this.filePath);
    } catch (error) {
      if (error.code === "ENOENT") existed = false;
      else throw error;
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const separator = this.#endsWithNewline ? "" : "\n";
    const payload =
      separator + additions.map((record) => encodeRecord(record)).join("\n") + "\n";
    const handle = await open(this.filePath, "a");
    try {
      await writeAllAndSync(handle, payload);
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
    const additions = this.#index.planAppend(observations, options);
    if (additions.length > 0) {
      try {
        await this.#persistAdditions(additions);
      } catch (error) {
        // Disk truth is now unknowable from memory (bytes may or may not
        // have landed). Reset so the next operation reloads the file: a
        // torn tail then correctly blocks appends and points at repair,
        // and a fully-landed write is re-read instead of re-applied.
        this.#resetState();
        throw error;
      }
      for (const record of additions) this.#index.apply(record);
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
    const compacted = this.#index.getRecordReferences().filter((record) => {
      if (record.type === "product") {
        const key = `${record.productId}\u0000${record.hash}\u0000${record.observedAt}`;
        if (productRevisions.has(key)) return false;
        productRevisions.add(key);
      }
      if (record.type === "store") {
        const key = `${record.storeId}\u0000${record.hash}\u0000${record.observedAt}`;
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

    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.compact-${process.pid}-${Date.now()}.tmp`;
    try {
      const handle = await open(tempPath, "w");
      try {
        // Stream in ~1 MB chunks instead of materializing one archive-sized
        // string plus its Buffer copy: same bytes on disk (records joined
        // by "\n", trailing "\n" when non-empty), one fh.sync() at the end,
        // peak transient memory bounded at ~2x the chunk size.
        let chunk = "";
        for (const [position, record] of compacted.entries()) {
          if (position > 0) chunk += "\n";
          chunk += encodeRecord(record);
          if (chunk.length >= 1048576) {
            await writeAll(handle, chunk);
            chunk = "";
          }
        }
        if (compacted.length > 0) chunk += "\n";
        if (chunk.length > 0) await writeAll(handle, chunk);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(tempPath, this.filePath);
      await this.#fsyncParentDir();
    } catch (error) {
      await rm(tempPath, { force: true });
      // Disk truth is unknowable from memory (the rename may have landed
      // even if a later step threw); reset so the next operation reloads.
      this.#resetState();
      throw error;
    }

    // Rebuild in-memory state from the compacted record set. The records are
    // exclusively owned here (resetState dropped the old index; nothing else
    // references them), so re-indexing needs no per-record clone.
    this.#resetState();
    for (const record of compacted) this.#index.applyParsed(record);
    this.#fileSignature = await this.#currentSignature();
    this.#loaded = true;
    return { records: this.#index.getRecords().length, file: this.filePath };
  }

  compact() {
    return this.#withLock(() => this.#compactLocked());
  }

  // ---- queries ----

  async productHistory(productId) {
    await this.#load();
    return this.#index.productHistory(productId);
  }

  async query(query = {}) {
    await this.#load();
    return this.#index.query(query);
  }

  /**
   * Record counts by type, distinct retailers across latest store revisions,
   * and the observedAt span — a passthrough of ArchiveIndex.stats().
   */
  async stats() {
    await this.#load();
    return this.#index.stats();
  }
}

/**
 * Cross-process exclusive archive lock: mkdir-based (atomic), with a
 * `pid` file inside naming the holder so a crashed writer's lock can be
 * reclaimed. Deliberately FAIL-FAST — a held lock throws immediately;
 * correctness comes from re-stat-reloading the file under the lock, not
 * from waiting (see DECISIONLOG 2026-08-23).
 *
 * On EEXIST the holder pid is read: dead (or unreadable) pid → the stale
 * directory is removed and acquisition retried ONCE; alive → throw.
 * process.kill(pid, 0) throwing EPERM still means ALIVE (the process
 * exists but is owned by another user). Shared by the repository's
 * internal writer protocol and scripts/repair-archive.js via
 * withArchiveLock().
 */
async function acquireArchiveLock(lockPath, writePid = true) {
  await mkdir(dirname(lockPath), { recursive: true });
  try {
    await mkdir(lockPath);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const holderPid = await readLockPid(lockPath);
    if (!holderPid || isProcessAlive(holderPid)) {
      const detail = holderPid ? `held by live process ${holderPid}` : "holder pid unknown";
      throw new Error(
        `Archive is locked by another writer (${lockPath}, ${detail}). ` +
          `If no writer is running, remove the lock directory.`,
        { cause: error },
      );
    }
    // Stale: the recorded pid is gone, so the writer died holding it.
    await rm(lockPath, { recursive: true, force: true });
    await mkdir(lockPath);
  }
  if (writePid) {
    // Written after acquire; a crash between mkdir and this write leaves
    // no pid file, which the next acquirer treats as stale (safe — an
    // unknown holder must prove it is alive to block anyone).
    try {
      await writeFile(join(lockPath, "pid"), `${process.pid}\n`);
    } catch {
      // Lock is held regardless; pid recording is best-effort recovery data.
    }
  }
}

/** Reads and parses a lock dir's `pid` file; null when absent/garbled. */
async function readLockPid(lockPath) {
  try {
    const raw = await readFile(join(lockPath, "pid"), "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM"; // exists but owned by another user
  }
}

/**
 * Runs `operation` while holding the cross-process archive lock for
 * `filePath`. See acquireArchiveLock() for the policy (fail-fast, pid
 * file, single stale-reclaim retry). Callers MUST (re-)read the archive
 * INSIDE the operation — anything scanned before acquiring the lock can
 * be stale by the time it is held.
 */
export async function withArchiveLock(filePath, operation) {
  const target = resolve(filePath);
  const lockPath = `${target}.lock`;
  await acquireArchiveLock(lockPath);
  try {
    return await operation();
  } finally {
    // rm -rf (not rmdir): the dir carries a pid file, and a crashed
    // previous holder may have left one behind inside ours.
    await rm(lockPath, { recursive: true, force: true }).catch(() => {});
  }
}
