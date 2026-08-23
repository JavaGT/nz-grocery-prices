import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlObservationRepository } from "../src/repository.js";
import { productRevisionHash } from "../src/archive-records.js";

function obs(overrides = {}) {
  return {
    product: { id: overrides.productId ?? "prod:1", name: overrides.name ?? "Milk" },
    store: { id: "store:1", retailer: "testretailer" },
    price: { regularCents: overrides.regularCents ?? 349 },
    source: { retailerProductId: overrides.sourceId ?? "111" },
    observedAt: overrides.observedAt ?? "2026-08-23T00:00:00.000Z",
  };
}

/** v2 product line whose stored hash matches its payload (a clean record). */
function cleanProductLine(productId, name) {
  const data = { id: productId, name };
  return JSON.stringify({
    version: 2,
    type: "product",
    productId,
    hash: productRevisionHash(data),
    observedAt: "2026-08-01T00:00:00.000Z",
    data,
  });
}

const validV2ProductLine = cleanProductLine("prod:0", "Seed");

// Envelope-valid v2 product record with a WRONG hash (bit-rot / hand-edit)
// to exercise defect collection without failing the envelope check.
const wrongHashLine =
  '{"version":2,"type":"product","productId":"prod:rot","hash":"' +
  "0".repeat(64) +
  '","observedAt":"2026-08-01T00:00:00.000Z","data":{"id":"prod:rot","name":"Rotten"}}';

describe("load protocol (CORE-2 M4)", () => {
  let directory;
  let filePath;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "prices-load-"));
    filePath = join(directory, "archive.jsonl");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("loads newline-terminated valid records", async () => {
    await writeFile(filePath, validV2ProductLine + "\n");
    const repository = new JsonlObservationRepository(filePath);
    assert.deepEqual(await repository.productHistory("prod:0"), [
      {
        hash: productRevisionHash({ id: "prod:0", name: "Seed" }),
        observedAt: "2026-08-01T00:00:00.000Z",
        product: { id: "prod:0", name: "Seed" },
      },
    ]);
    assert.equal(repository.getLoadDefects().length, 0);
  });

  it("loads snapshot records cleanly; offersHash is never recomputed", async () => {
    // Regression: snapshots carry offersHash over listing state rather than a
    // payload hash+data pair. Hash verification must skip them instead of
    // treating them as corrupt.
    const validV2SnapshotLine =
      '{"version":2,"type":"snapshot","scope":"specials","storeId":"store:0",' +
      '"observedAt":"2026-08-02T00:00:00.000Z","offerCount":1,' +
      '"offersHash":"' + "a".repeat(64) + '",' +
      '"added":["prod:s\\u0000store:0"],"removed":[]}\n';
    await writeFile(filePath, validV2SnapshotLine);
    const repository = new JsonlObservationRepository(filePath);
    await repository.append([
      {
        product: { id: "prod:s", name: "Cheese" },
        store: { id: "store:0", retailer: "t" },
        price: { regularCents: 500 },
        source: { retailerProductId: "p1" },
        observedAt: "2026-08-03T00:00:00.000Z",
      },
    ]);
    assert.equal(repository.getLoadDefects().length, 0);
    const [observation] = await repository.query({ productId: "prod:s" });
    assert.equal(observation.isOnSpecial, true);
  });

  it("throws naming file:line for a terminated invalid line (even when last)", async () => {
    // Corrupt line in the middle.
    await writeFile(filePath, validV2ProductLine + '\n{"version":3,"type":"product"}\n');
    const repository = new JsonlObservationRepository(filePath);
    await assert.rejects(() => repository.query(), /archive\.jsonl:2/);

    // Corrupt line IS the final line (terminated).
    await writeFile(filePath, validV2ProductLine + "\nnot json at all\n");
    const second = new JsonlObservationRepository(filePath);
    await assert.rejects(() => second.query(), /archive\.jsonl:2/);
  });

  it("recovers an unterminated final line as a queryable record", async () => {
    const tail = validV2ProductLine.replace("prod:0", "prod:1");
    await writeFile(filePath, validV2ProductLine + "\n" + tail);
    const repository = new JsonlObservationRepository(filePath);
    const history = await repository.productHistory("prod:1");
    assert.equal(history.length, 1);
    assert.equal(history[0].product.name, "Seed");

    // The recovered tail must not glue to the next append: every line in
    // the file must still parse independently afterwards.
    await repository.append([obs({ productId: "prod:9", sourceId: "999" })]);
    const contents = await readFile(filePath, "utf8");
    const lines = contents.split("\n").filter((entry) => entry !== "");
    for (const line of lines) JSON.parse(line);
    // seed + recovered product + appended product/store/offer = 5.
    assert.equal(lines.length, 5);

    const reopened = new JsonlObservationRepository(filePath);
    const queried = await reopened.query();
    assert.equal(queried.filter((entry) => entry.product.id === "prod:9").length, 1);
  });

  it("an undecodable unterminated tail blocks append and compact", async () => {
    await writeFile(filePath, validV2ProductLine + "\n{");
    const repository = new JsonlObservationRepository(filePath);

    // Queries still work over the good prefix.
    assert.equal((await repository.productHistory("prod:0")).length, 1);

    await assert.rejects(
      () => repository.append([obs()]),
      /torn[\s\S]*refusing to append/i,
    );
    await assert.rejects(() => repository.compact(), /torn[\s\S]*refusing to compact/i);

    // A fresh instance must also refuse (the flag is derived at load).
    const reopened = new JsonlObservationRepository(filePath);
    await assert.rejects(() => reopened.append([obs()]), /torn/);
  });

  it("collects hash mismatches via getLoadDefects() while queries still work", async () => {
    await writeFile(filePath, validV2ProductLine + "\n" + wrongHashLine + "\n");
    const repository = new JsonlObservationRepository(filePath);
    // Loading happens on first query; defects reflect the most recent load.
    assert.equal((await repository.productHistory("prod:0")).length, 1);
    const defects = repository.getLoadDefects();
    assert.equal(defects.length, 1);
    assert.equal(defects[0].line, 2);
    assert.equal(defects[0].type, "product");
    assert.equal(defects[0].id, "prod:rot");
    assert.equal(defects[0].stored, "0".repeat(64));
    assert.match(defects[0].recomputed, /^[0-9a-f]{64}$/);
    // Data still queries despite the defect.
    assert.equal((await repository.productHistory("prod:rot")).length, 1);
  });

  it("envelope violations throw with the line number", async () => {
    await writeFile(filePath, '{"version":2,"type":"snapshot"}\n');
    const repository = new JsonlObservationRepository(filePath);
    await assert.rejects(
      () => repository.query(),
      /archive\.jsonl:1 [\s\S]*snapshot record scope must be/,
    );
  });
});
