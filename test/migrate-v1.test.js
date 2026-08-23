import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonlObservationRepository } from "../src/repository.js";
import {
  fingerprint,
  offerRevisionHash,
  productRevisionHash,
  storeRevisionHash,
} from "../src/archive-records.js";

const run = promisify(execFile);
const cli = new URL("../scripts/migrate-v1-archive.js", import.meta.url).pathname;

function v1(overrides = {}) {
  return JSON.stringify({
    product: { id: overrides.productId ?? "prod:1", name: overrides.name ?? "Milk" },
    store: { id: overrides.storeId ?? "store:1", retailer: overrides.retailer ?? "testretailer" },
    price: { regularCents: overrides.regularCents ?? 349 },
    source: { retailerProductId: overrides.sourceId ?? "111" },
    observedAt: overrides.observedAt ?? "2026-08-23T00:00:00.000Z",
    ...(overrides.promotion ? { promotion: overrides.promotion } : {}),
  });
}

function v2ProductLine(productId, name) {
  const data = { id: productId, name };
  return JSON.stringify({
    version: 2, type: "product", productId,
    hash: productRevisionHash(data),
    observedAt: "2026-08-01T00:00:00.000Z", data,
  });
}

function v2StoreLine(storeId, retailer = "testretailer") {
  const data = { id: storeId, retailer };
  return JSON.stringify({
    version: 2, type: "store", storeId,
    hash: storeRevisionHash(data),
    observedAt: "2026-08-01T00:00:00.000Z", data,
  });
}

function v2OfferLine(productId, storeId, regularCents, observedAt) {
  const data = {
    price: { regularCents },
    source: { retailerProductId: "111" },
  };
  return JSON.stringify({
    version: 2, type: "offer",
    offerId: `${productId}\u0000${storeId}`,
    productId, storeId,
    hash: offerRevisionHash(data),
    observedAt, data,
  });
}

/** Parse every line of a migrated file back into records, in order. */
function parseLines(contents) {
  return contents
    .split("\n")
    .filter((entry) => entry !== "")
    .map((entry) => JSON.parse(entry));
}

describe("migrate-v1-archive CLI (CORE-6)", () => {
  let directory;
  let filePath;
  // A fake "repo root" so live-path-refusal tests resolve data/prices.jsonl
  // inside the temp dir and can NEVER touch the real archive.
  let fakeRoot;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "prices-migrate-"));
    filePath = join(directory, "archive.jsonl");
    fakeRoot = join(directory, "root");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  // ---- CLI guards ----

  it("requires an explicit --file", async () => {
    await assert.rejects(
      () => run("node", [cli], { cwd: directory }),
      (error) => error.code === 1 && /--file <path> is required/.test(error.stderr),
    );
  });

  it("rejects bare positional arguments", async () => {
    await assert.rejects(
      () => run("node", [cli, filePath], { cwd: directory }),
      (error) => error.code === 1 && /Unexpected argument/.test(error.stderr),
    );
  });

  it("refuses *.db paths citing the two-DB rule", async () => {
    const dbPath = join(directory, "prices.db");
    await writeFile(dbPath, "");
    await assert.rejects(
      () => run("node", [cli, "--file", dbPath]),
      (error) => error.code === 1 && /two-DB rule/.test(error.stderr),
    );
  });

  it("refuses *.DB paths case-insensitively", async () => {
    const dbPath = join(directory, "prices.DB");
    await writeFile(dbPath, "");
    await assert.rejects(
      () => run("node", [cli, "--file", dbPath]),
      (error) => error.code === 1 && /two-DB rule/.test(error.stderr),
    );
  });

  it("refuses the live data/prices.jsonl without --force, before touching anything", async () => {
    await mkdir(join(fakeRoot, "data"), { recursive: true });
    await writeFile(join(fakeRoot, "data", "prices.jsonl"), v1() + "\n");
    await assert.rejects(
      () => run("node", [cli, "--file", join(fakeRoot, "data", "prices.jsonl")], { cwd: fakeRoot }),
      (error) => error.code === 1 && /--force/.test(error.stderr),
    );
    // Refusal happened before any rewrite: file untouched, still v1.
    assert.match(await readFile(join(fakeRoot, "data", "prices.jsonl"), "utf8"), /"product"/);
    const entries = await readdir(join(fakeRoot, "data"));
    assert.equal(entries.some((entry) => entry.includes(".lock")), false);
  });

  it("accepts both --file <path> and --file=<path> forms", async () => {
    await writeFile(filePath, v1() + "\n");
    const spaced = await run("node", [cli, "--file", filePath, "--dry-run"]);
    assert.equal(JSON.parse(spaced.stdout).v1, 1);
    const equals = await run("node", [cli, `--file=${filePath}`, "--dry-run"]);
    assert.equal(JSON.parse(equals.stdout).v1, 1);
  });

  it("refuses to run while another writer holds the archive lock", async () => {
    await writeFile(filePath, v1() + "\n");
    const { mkdir: smkdir, rmdir } = await import("node:fs/promises");
    await smkdir(`${filePath}.lock`);
    try {
      await assert.rejects(
        () => run("node", [cli, "--file", filePath]),
        (error) => error.code === 1 && /locked by another writer/.test(error.stderr),
      );
      // File untouched by the refused run.
      assert.match(await readFile(filePath, "utf8"), /"product"/);
    } finally {
      await rmdir(`${filePath}.lock`);
    }
  });

  // ---- dry run ----

  it("dry run reports counts and changes without touching the file", async () => {
    const contents = [
      v1({ productId: "prod:1", name: "Milk", sourceId: "s1" }),
      v2ProductLine("prod:9", "Seed"),
      v1({ productId: "prod:2", name: "Bread", sourceId: "s2" }),
    ].join("\n") + "\n";
    await writeFile(filePath, contents);

    const result = await run("node", [cli, "--file", filePath, "--dry-run"]);
    const report = JSON.parse(result.stdout);
    assert.equal(report.v1, 2);
    assert.equal(report.v2, 1);
    assert.equal(report.invalid, 0);
    assert.equal(report.changes, 5, "v1#1 derives product+store+offer; v1#2 reuses the store");
    assert.equal(report.dryRun, true);
    assert.equal(await readFile(filePath, "utf8"), contents, "file byte-identical");
    const entries = await readdir(directory);
    assert.equal(entries.length, 1, "no backup/quarantine/temp files in dry run");
  });

  // ---- mixed-fixture apply ----

  it("migrates a mixed archive in original line order, preserving v2 bytes", async () => {
    const v1First = v1({ productId: "prod:1", name: "Milk", sourceId: "s1" });
    const v2Line = v2ProductLine("prod:9", "Seed");
    const v1Second = v1({
      productId: "prod:2", name: "Bread", sourceId: "s2",
      regularCents: 999, observedAt: "2026-08-22T00:00:00.000Z",
    });
    await writeFile(filePath, [v1First, v2Line, v1Second].join("\n") + "\n");

    const report = JSON.parse(
      (await run("node", [cli, "--file", filePath])).stdout,
    );
    assert.equal(report.v1, 2);
    assert.equal(report.v2, 1);
    assert.equal(report.invalid, 0);
    assert.equal(report.changes, 6);

    const records = parseLines(await readFile(filePath, "utf8"));
    // Order: v1#1 derivations (product, store, offer), then the untouched
    // v2 line, then v1#2 derivations. v1#2 is BACKDATED (2026-08-22 <
    // v1#1's 2026-08-23), so its shared store is re-emitted as an earlier
    // temporal anchor rather than deduped against the future revision.
    assert.equal(records.length, 7);
    assert.equal(records[0].type, "product");
    assert.equal(records[0].productId, "prod:1");
    assert.equal(records[1].type, "store");
    assert.equal(records[2].type, "offer");
    assert.equal(records[2].offerId, "prod:1\u0000store:1");
    assert.equal(records[3].type, "product", "v2 line preserved in position");
    assert.deepEqual(records[3], JSON.parse(v2Line), "v2 line byte-identical");
    assert.equal(records[4].type, "product");
    assert.equal(records[4].productId, "prod:2");
    assert.equal(records[5].type, "store", "backdated store anchor re-emitted");
    assert.equal(records[5].observedAt, "2026-08-22T00:00:00.000Z");
    assert.equal(records[6].type, "offer");
    assert.equal(records[6].offerId, "prod:2\u0000store:1");
    assert.equal(records[6].data.price.regularCents, 999);

    // Every emitted record is envelope-valid v2 with correct hashes.
    for (const record of records) {
      assert.equal(record.version, 2);
      assert.ok(record.hash);
    }
    assert.equal(
      records[0].hash,
      productRevisionHash({ id: "prod:1", name: "Milk" }),
    );
    assert.equal(
      records[2].hash,
      offerRevisionHash({
        price: { regularCents: 349 },
        source: { retailerProductId: "s1" },
      }),
    );
  });

  it("derives against ALL preceding state — a v1 line after a v2 offer adds no duplicate", async () => {
    // The v2 offer already covers prod:1@store:1 at this observedAt with the
    // same price/source, so the v1 line must derive ZERO new records.
    await writeFile(filePath, [
      v2ProductLine("prod:1", "Milk"),
      v2StoreLine("store:1"),
      v2OfferLine("prod:1", "store:1", 349, "2026-08-23T00:00:00.000Z"),
      v1({ productId: "prod:1", sourceId: "111" }),
    ].join("\n") + "\n");

    const report = JSON.parse(
      (await run("node", [cli, "--file", filePath])).stdout,
    );
    assert.equal(report.v1, 1);
    assert.equal(report.changes, 0, "no facts invented for an already-covered observation");
    assert.deepEqual(parseLines(await readFile(filePath, "utf8")).length, 3);
  });

  it("quarantines invalid lines instead of inventing data around them", async () => {
    await writeFile(filePath, [
      v1({ productId: "prod:1", sourceId: "s1" }),
      "garbage-not-json",
      '{"version":2,"type":"snapshot"}', // envelope violation
      // v1-shaped but fails observation validation (empty product.id).
      JSON.stringify({
        product: { id: "", name: "Broken" },
        store: { id: "store:2", retailer: "testretailer" },
        price: { regularCents: 100 },
        source: { retailerProductId: "s3" },
        observedAt: "2026-08-23T00:00:00.000Z",
      }),
    ].join("\n") + "\n");

    const report = JSON.parse(
      (await run("node", [cli, "--file", filePath])).stdout,
    );
    assert.equal(report.invalid, 3);
    assert.equal(report.v1, 1);
    assert.ok(report.quarantineFile, "quarantine file reported");

    const quarantined = (await readFile(report.quarantineFile, "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.deepEqual(quarantined.map((entry) => entry.line).sort((a, b) => a - b), [2, 3, 4]);
    assert.match(quarantined.find((entry) => entry.line === 3).reason, /scope must be/);
    assert.match(
      quarantined.find((entry) => entry.line === 4).reason,
      /v1 observation invalid/,
    );

    // Migrated file keeps only decodable content, in order.
    const records = parseLines(await readFile(filePath, "utf8"));
    assert.equal(records.length, 3);
    assert.equal(records[0].type, "product");
    assert.equal(records[2].type, "offer");
  });

  it("quarantines invalid-only input without rewriting the archive", async () => {
    const original = "not-json\n";
    await writeFile(filePath, original);

    const report = JSON.parse(
      (await run("node", [cli, "--file", filePath])).stdout,
    );
    assert.equal(report.v1, 0);
    assert.equal(report.v2, 0);
    assert.equal(report.invalid, 1);
    assert.ok(report.quarantineFile);
    assert.equal(await readFile(filePath, "utf8"), original);
    assert.equal(
      (await readdir(directory)).filter((entry) => entry.includes("pre-v2-migration")).length,
      0,
      "invalid-only input does not create a migration backup",
    );
  });

  it("creates an fsynced backup of the original before replacing", async () => {
    const original = v1({ productId: "prod:1", sourceId: "s1" }) + "\n";
    await writeFile(filePath, original);

    const report = JSON.parse(
      (await run("node", [cli, "--file", filePath])).stdout,
    );
    assert.ok(report.backupFile, "backup file reported");
    assert.equal(await readFile(report.backupFile, "utf8"), original, "backup holds the original bytes");
    assert.notEqual(report.backupFile, filePath);
  });

  it("backup preserves the original bytes EXACTLY — blank lines and missing final newline", async () => {
    // Blank lines between records + no trailing newline: a re-serialization
    // of parsed lines would normalize these away; the backup must not.
    const exact =
      "\n" +
      v1({ productId: "prod:1", name: "Milk", sourceId: "s1" }) + "\n" +
      "\n\n" +
      v2ProductLine("prod:9", "Seed"); // NO trailing newline
    await writeFile(filePath, exact);

    const report = JSON.parse(
      (await run("node", [cli, "--file", filePath])).stdout,
    );
    assert.equal(report.v1, 1);
    assert.ok(report.backupFile);
    assert.equal(
      await readFile(report.backupFile, "utf8"),
      exact,
      "backup is byte-identical to the original including blank lines and tail",
    );

    // The migrated file itself stays parseable despite the blank lines.
    const migrated = await readFile(filePath, "utf8");
    assert.match(migrated, /\n$/, "rewritten file is newline-terminated");
    for (const line of migrated.split("\n").filter((entry) => entry !== "")) {
      JSON.parse(line); // must not throw
    }
  });

  it("second run is a no-op: no rewrite, no new backup", async () => {
    await writeFile(filePath, [
      v1({ productId: "prod:1", sourceId: "s1" }),
      v2ProductLine("prod:9", "Seed"),
    ].join("\n") + "\n");

    const first = JSON.parse(
      (await run("node", [cli, "--file", filePath])).stdout,
    );
    assert.equal(first.v1, 1);
    const migrated = await readFile(filePath, "utf8");

    const second = JSON.parse(
      (await run("node", [cli, "--file", filePath])).stdout,
    );
    assert.equal(second.v1, 0);
    assert.equal(second.changes, 0);
    assert.equal(second.backupFile, undefined, "no backup written when nothing to migrate");
    assert.equal(await readFile(filePath, "utf8"), migrated, "file byte-identical after second run");
  });

  // ---- round-trip: migrated archive loads and queries identically ----

  it("round-trip: migrated archive reloads and queries equivalent to pre-cutover projection", async () => {
    // Build the same fact set two ways:
    //   A) v1 lines migrated by the CLI
    //   B) equivalent observations appended through the normal v2 writer
    const observations = [
      {
        product: { id: "prod:1", name: "Milk" },
        store: { id: "store:1", retailer: "testretailer" },
        price: { regularCents: 349 },
        source: { retailerProductId: "s1" },
        observedAt: "2026-08-20T00:00:00.000Z",
      },
      {
        product: { id: "prod:2", name: "Bread" },
        store: { id: "store:1", retailer: "testretailer" },
        price: { regularCents: 500, promoCents: 399 },
        source: { retailerProductId: "s2" },
        observedAt: "2026-08-21T00:00:00.000Z",
        promotion: { type: "SPECIAL", savePercent: 20 },
      },
      {
        product: { id: "prod:1", name: "Milk" },
        store: { id: "store:1", retailer: "testretailer" },
        price: { regularCents: 299 },
        source: { retailerProductId: "s1" },
        observedAt: "2026-08-22T00:00:00.000Z",
      },
    ];

    const dirA = join(directory, "a");
    const dirB = join(directory, "b");
    await mkdir(dirA);
    await mkdir(dirB);
    const fileA = join(dirA, "archive.jsonl");
    const fileB = join(dirB, "archive.jsonl");

    await writeFile(fileA, observations.map((observation) => JSON.stringify(observation)).join("\n") + "\n");
    await run("node", [cli, "--file", fileA]);

    const writer = new JsonlObservationRepository(fileB);
    await writer.append(observations);

    const repoA = new JsonlObservationRepository(fileA);
    const repoB = new JsonlObservationRepository(fileB);
    const queriedA = await repoA.query();
    const queriedB = await repoB.query();

    assert.equal(repoA.getLoadDefects().length, 0, "migrated archive loads defect-free");
    assert.deepEqual(queriedA, queriedB, "same observations materialize from both paths");
    assert.equal(queriedA.length, 3);
    assert.deepEqual(await repoA.stats(), await repoB.stats());

    // And the migrated file is itself stable under a second migration pass.
    const second = JSON.parse((await run("node", [cli, "--file", fileA])).stdout);
    assert.equal(second.v1, 0);
  });

  it("migrates an archive whose final v1 line lacks a trailing newline", async () => {
    await writeFile(filePath, v1({ productId: "prod:1", sourceId: "s1" })); // no \n

    const report = JSON.parse(
      (await run("node", [cli, "--file", filePath])).stdout,
    );
    assert.equal(report.v1, 1);
    assert.equal(report.changes, 3);
    const contents = await readFile(filePath, "utf8");
    assert.match(contents, /\n$/, "rewritten file is newline-terminated");
    assert.equal(parseLines(contents).length, 3);

    // Reloads cleanly through the normal loader post-cutover.
    const repository = new JsonlObservationRepository(filePath);
    assert.equal((await repository.query()).length, 1);
  });
});
