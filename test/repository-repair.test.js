import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, readdir, mkdir, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { JsonlObservationRepository } from "../src/repository.js";
import {
  fingerprint,
  offerRevisionHash,
  productRevisionHash,
} from "../src/archive-records.js";

const run = promisify(execFile);
const cli = new URL("../scripts/repair-archive.js", import.meta.url).pathname;

function obs(overrides = {}) {
  return {
    product: { id: overrides.productId ?? "prod:1", name: overrides.name ?? "Milk" },
    store: { id: "store:1", retailer: "testretailer" },
    price: { regularCents: overrides.regularCents ?? 349 },
    source: { retailerProductId: overrides.sourceId ?? "111" },
    observedAt: overrides.observedAt ?? "2026-08-23T00:00:00.000Z",
  };
}

describe("repair CLI (CORE-2 M5)", () => {
  let directory;
  let filePath;
  // A fake "repo root" so live-path-refusal tests resolve data/prices.jsonl
  // inside the temp dir and can NEVER touch the real archive.
  let fakeRoot;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "prices-repair-"));
    filePath = join(directory, "archive.jsonl");
    fakeRoot = join(directory, "root");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("refuses *.db paths citing the two-DB rule", async () => {
    const dbPath = join(directory, "prices.db");
    await writeFile(dbPath, "");
    await assert.rejects(
      () => run("node", [cli, "--file", dbPath]),
      (error) => error.code === 1 && /two-DB rule/.test(error.stderr),
    );
  });

  it("refuses data/prices.jsonl without --force, before touching anything", async () => {
    await mkdir(join(fakeRoot, "data"), { recursive: true });
    await writeFile(join(fakeRoot, "data", "prices.jsonl"), "seed\n");
    await assert.rejects(
      () => run("node", [cli, "--file", join(fakeRoot, "data", "prices.jsonl")], { cwd: fakeRoot }),
      (error) => error.code === 1 && /--force/.test(error.stderr),
    );
    // Refusal happened before the scan: file untouched.
    assert.equal(await readFile(join(fakeRoot, "data", "prices.jsonl"), "utf8"), "seed\n");
  });

  it("round-trips a synthetic corrupt archive: quarantine + atomic rewrite", async () => {
    // Build a corrupt archive: clean product, terminated-garbage line,
    // clean offer, torn unterminated fragment.
    const productData = { id: "prod:ok", name: "Good" };
    const productLine = JSON.stringify({
      version: 2, type: "product", productId: "prod:ok",
      hash: productRevisionHash(productData),
      observedAt: "2026-08-01T00:00:00.000Z", data: productData,
    });
    const offerData = {
      price: { regularCents: 349 },
      source: { retailerProductId: "111" },
    };
    const offerLine = JSON.stringify({
      version: 2, type: "offer",
      offerId: "prod:ok\u0000store:1", productId: "prod:ok", storeId: "store:1",
      hash: offerRevisionHash(offerData),
      observedAt: "2026-08-02T00:00:00.000Z", data: offerData,
    });
    const storeData = { id: "store:1", retailer: "testretailer" };
    const storeLine = JSON.stringify({
      version: 2, type: "store", storeId: "store:1",
      hash: fingerprint(storeData),
      observedAt: "2026-08-01T00:00:00.000Z", data: storeData,
    });
    const contents =
      productLine + "\n" +
      storeLine + "\n" +
      '{"version":2,"type":"snapshot"}\n' + // envelope violation mid-file
      offerLine + "\n" +
      '{"version":2,"type":"offer","offerId":"torn'; // torn tail
    await writeFile(filePath, contents);

    const result = await run("node", [cli, "--file", filePath]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.scanned, 5);
    assert.equal(report.kept, 3); // product + store + offer survive
    assert.equal(report.recovered, 0); // torn fragment was NOT recoverable
    assert.equal(report.quarantined, 2); // bad line + torn fragment
    assert.equal(report.defects.length, 0);

    // Quarantine file exists next to the archive and holds both fragments.
    const entries = await readdir(directory);
    const quarantine = entries.find((entry) => entry.startsWith("archive.jsonl.corrupt-"));
    assert.ok(quarantine, "quarantine file must exist");
    const quarantined = (await readFile(join(directory, quarantine), "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.deepEqual(
      quarantined.map((entry) => entry.line).sort(),
      [3, 5], // the envelope-violating line + the torn fragment
    );

    // The repaired file reloads cleanly through the normal loader.
    const repository = new JsonlObservationRepository(filePath);
    const queried = await repository.query();
    assert.equal(queried.length, 1);
    assert.equal(queried[0].product.id, "prod:ok");
    assert.equal(repository.getLoadDefects().length, 0);

    // No temp leftovers.
    assert.equal(entries.some((entry) => entry.includes(".repair-")), false);
  });

  it("refuses to run while another writer holds the archive lock, then succeeds once it is released", async () => {
    const productData = { id: "prod:lock", name: "Locked" };
    await writeFile(filePath, JSON.stringify({
      version: 2, type: "product", productId: "prod:lock",
      hash: productRevisionHash(productData),
      observedAt: "2026-08-01T00:00:00.000Z", data: productData,
    }) + "\n");

    // Hold the lock externally, exactly as a live writer would.
    await mkdir(`${filePath}.lock`);
    await assert.rejects(
      () => run("node", [cli, "--file", filePath]),
      (error) => error.code === 1 && /locked by another writer/.test(error.stderr),
    );
    // Refusal happened before the scan/rewrite: file untouched.
    assert.match(await readFile(filePath, "utf8"), /prod:lock/);

    // Lock released → repair succeeds and the lock is gone afterwards.
    await rmdir(`${filePath}.lock`);
    const result = await run("node", [cli, "--file", filePath]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.kept, 1);
    const entries = await readdir(directory);
    assert.equal(entries.some((entry) => entry.endsWith(".lock")), false);
  });

  it("recovers an unterminated-but-valid tail record during repair", async () => {
    const productData = { id: "prod:t", name: "Tail" };
    const tail = JSON.stringify({
      version: 2, type: "product", productId: "prod:t",
      hash: productRevisionHash(productData),
      observedAt: "2026-08-01T00:00:00.000Z", data: productData,
    });
    await writeFile(filePath, tail); // single line, no trailing newline

    const result = await run("node", [cli, "--file", filePath]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.kept, 1);
    assert.equal(report.recovered, 1);
    assert.equal(report.quarantined, 0);

    // Repaired file now ends with a newline.
    assert.match(await readFile(filePath, "utf8"), /\n$/);
  });

  it("rewrites mismatched hashes so the archive loads defect-free afterwards", async () => {
    const productData = { id: "prod:rot", name: "Rotten" };
    const badHashLine = JSON.stringify({
      version: 2, type: "product", productId: "prod:rot",
      hash: "0".repeat(64), // stored ≠ recomputed
      observedAt: "2026-08-01T00:00:00.000Z", data: productData,
    });
    await writeFile(filePath, badHashLine + "\n");

    const result = await run("node", [cli, "--file", filePath]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.defects.length, 1);
    assert.equal(report.defects[0].stored, "0".repeat(64));

    const repository = new JsonlObservationRepository(filePath);
    await repository.productHistory("prod:rot");
    assert.equal(repository.getLoadDefects().length, 0, "hash rewritten by repair");
    const history = await repository.productHistory("prod:rot");
    assert.equal(history[0].hash, productRevisionHash(productData));
  });
});
