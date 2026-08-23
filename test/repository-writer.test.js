import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir, stat, writeFile, mkdir, rmdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlObservationRepository } from "../src/repository.js";

function obs(overrides = {}) {
  return {
    product: { id: overrides.productId ?? "prod:1", name: overrides.name ?? "Milk" },
    store: { id: "store:1", retailer: "testretailer" },
    price: { regularCents: overrides.regularCents ?? 349 },
    source: { retailerProductId: overrides.sourceId ?? "111" },
    observedAt: overrides.observedAt ?? "2026-08-23T00:00:00.000Z",
  };
}

const v2ProductLine =
  '{"version":2,"type":"product","productId":"prod:0","hash":"deadbeef",' +
  '"observedAt":"2026-08-01T00:00:00.000Z","data":{"id":"prod:0","name":"Seed"}}\n';

describe("writer protocol (CORE-2 M3)", () => {
  let directory;
  let filePath;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "prices-writer-"));
    filePath = join(directory, "archive.jsonl");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("appended records are visible to a fresh repository instance (crash-restart)", async () => {
    const repository = new JsonlObservationRepository(filePath);
    await repository.append([obs()]);
    const reopened = new JsonlObservationRepository(filePath);
    const observations = await reopened.query();
    assert.equal(observations.length, 1);
    assert.equal(observations[0].product.id, "prod:1");
  });

  it("appending onto a file lacking a trailing newline does not glue records", async () => {
    await writeFile(filePath, v2ProductLine.replace("\n", ""));
    const repository = new JsonlObservationRepository(filePath);
    const added = await repository.append([obs({ productId: "prod:9", sourceId: "999" })]);
    assert.equal(added, 3);

    // Every line in the file must parse independently.
    const contents = await readFile(filePath, "utf8");
    const lines = contents.split("\n").filter((line) => line.trim() !== "");
    assert.equal(lines.length, 4);
    const parsed = lines.map((line) => JSON.parse(line));
    assert.equal(parsed.filter((record) => record.type === "offer").length, 1);
    assert.equal(parsed[0].type, "product"); // seed survived intact
  });

  it("holds <archive>.lock during mutation and releases it on success", async () => {
    const repository = new JsonlObservationRepository(filePath);
    await repository.append([obs()]);
    const entries = await readdir(directory);
    assert.equal(entries.some((entry) => entry === "archive.jsonl.lock"), false);
  });

  it("releases the lock when the operation fails mid-flight", async () => {
    // A directory where the archive should be makes open(path, 'a') fail
    // after the lock is held.
    await mkdir(filePath);
    const repository = new JsonlObservationRepository(filePath);
    await assert.rejects(() => repository.append([obs()]));
    const entries = await readdir(directory);
    assert.equal(entries.some((entry) => entry.endsWith(".lock")), false);
  });

  it("refuses to mutate while another writer holds the lock", async () => {
    await writeFile(filePath, v2ProductLine);
    const repository = new JsonlObservationRepository(filePath);
    await repository.query(); // populate memory
    await mkdir(`${filePath}.lock`);
    await assert.rejects(
      () => repository.append([obs()]),
      /Archive is locked by another writer/,
    );
    await rmdir(`${filePath}.lock`);
    // Lock freed → the same call succeeds afterwards.
    await repository.append([obs({ productId: "prod:2", sourceId: "222" })]);
    assert.equal((await repository.query()).length, 1);
  });

  it("serializes concurrent appends without losing or duplicating records", async () => {
    const repository = new JsonlObservationRepository(filePath);
    const batches = Array.from({ length: 12 }, (_, index) =>
      obs({ productId: `prod:${index}`, sourceId: `src:${index}` }),
    ).map((observation) => repository.append([observation]));
    const counts = await Promise.all(batches);
    // Batch 1 pays product+store+offer (3); the rest share the store so pay
    // product+offer only (2).
    assert.deepEqual(counts, [3, ...Array.from({ length: 11 }, () => 2)]);

    const reopened = new JsonlObservationRepository(filePath);
    assert.equal((await reopened.query()).length, 12);
    const contents = await readFile(filePath, "utf8");
    const lines = contents.split("\n").filter((line) => line.trim() !== "");
    // Batch 1 pays product+store+offer (3); the other 11 share the store and
    // pay product+offer (2) each: 3 + 11×2 = 25.
    assert.equal(lines.length, 25);
    for (const line of lines) JSON.parse(line);
  });

  it("a failed persist resets memory so disk truth wins on retry", async () => {
    const repository = new JsonlObservationRepository(filePath);
    await repository.append([obs({ productId: "prod:keep", sourceId: "k" })]);

    // Sabotage: remove the archive and put a directory in its place.
    const { unlink } = await import("node:fs/promises");
    await unlink(filePath);
    await mkdir(filePath);
    await assert.rejects(() => repository.append([obs({ productId: "prod:lost", sourceId: "l" })]));

    // Restore a valid (empty) archive at the path and retry. The failed
    // persist reset memory, so the retry reloads from disk (now empty) and
    // plans fresh — nothing is assumed to have "not landed".
    await rmdir(filePath);
    const added = await repository.append([obs({ productId: "prod:retry", sourceId: "r" })]);
    assert.equal(added, 3);

    const reopened = new JsonlObservationRepository(filePath);
    const products = (await reopened.query()).map((o) => o.product.id).sort();
    // prod:keep was lost with the sabotaged file (disk truth won via reload);
    // the retried batch is fully present exactly once.
    assert.deepEqual(products, ["prod:retry"]);
  });

  it("a short write (bytesWritten < length) is retried until the full payload lands", async () => {
    const repository = new JsonlObservationRepository(filePath);
    await repository.append([obs({ productId: "prod:seed", sourceId: "s" })]);

    // Patch FileHandle.prototype.write so the FIRST call reports a short
    // write (writes only 3 real bytes, claims bytesWritten: 3), then
    // delegates for all subsequent calls. Every handle shares this
    // prototype, so the repository's append write hits it. The prototype
    // is not a named export of node:fs/promises, so reach it via a probe
    // handle.
    const probe = await open(filePath, "r");
    const prototype = Object.getPrototypeOf(probe);
    await probe.close();
    const realWrite = prototype.write;
    const shortWrite = mock.method(prototype, "write", async function (...args) {
      if (shortWrite.mock.callCount() === 0) {
        const [buffer] = args;
        const truncated = buffer.subarray(0, 3);
        await realWrite.call(this, truncated, 0);
        return { bytesWritten: 3, buffer };
      }
      return realWrite.apply(this, args);
    });

    let added;
    try {
      added = await repository.append([obs({ productId: "prod:short", sourceId: "sh" })]);
    } finally {
      shortWrite.mock.restore();
    }
    assert.equal(added, 2); // product + offer (store already seeded)

    // The truncated 3-byte prefix was retried from the right offset, so
    // every line still parses and no bytes were dropped or duplicated.
    const contents = await readFile(filePath, "utf8");
    const lines = contents.split("\n").filter((line) => line.trim() !== "");
    assert.equal(lines.length, 5); // seed 3 + product + offer
    for (const line of lines) JSON.parse(line);

    // A reopened instance sees everything the short-write append wrote.
    const reopened = new JsonlObservationRepository(filePath);
    const observations = await reopened.query();
    assert.deepEqual(
      observations.map((entry) => entry.product.id).sort(),
      ["prod:seed", "prod:short"],
    );
  });

  it("compact() replaces the inode atomically and preserves data", async () => {
    const repository = new JsonlObservationRepository(filePath);
    await repository.append([
      obs({ productId: "prod:a", sourceId: "a" }),
      obs({ productId: "prod:b", sourceId: "b", regularCents: 500 }),
    ]);
    const before = await stat(filePath);
    const result = await repository.compact();
    const after = await stat(filePath);

    assert.notEqual(after.ino, before.ino, "compact must rename, not write in place");
    // 2 products + 1 shared store + 2 offers = 5 change-only records.
    assert.equal(result.records, 5);
    assert.ok(result.file.endsWith("archive.jsonl"));

    const entries = await readdir(directory);
    assert.equal(entries.some((entry) => entry.includes(".tmp")), false, "no temp leftovers");

    const reopened = new JsonlObservationRepository(filePath);
    assert.equal((await reopened.query()).length, 2);
  });
});
