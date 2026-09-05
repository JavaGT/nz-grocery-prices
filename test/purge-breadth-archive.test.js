import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purgeArchive } from "../scripts/purge-breadth-archive.js";

function writeFileFixture(file, lines) {
  return writeFile(file, lines.join("\n") + "\n");
}

const record = (over = {}) =>
  JSON.stringify({
    version: 2,
    type: "store",
    hash: "x".repeat(64),
    observedAt: "2026-09-01T00:00:00.000Z",
    ...over,
  });

describe("purge-breadth-archive", () => {
  it("removes stray-retailer records, keeps a backup, and is idempotent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "purge-breadth-"));
    try {
      const file = join(dir, "breadth-pilot.jsonl");
      await writeFileFixture(file, [
        record({ storeId: "paknsave:pns-1" }),
        record({ storeId: "newworld:nw-1" }),
        record({
          type: "offer",
          offerId: "newworld:p1\u0000newworld:nw-1",
          productId: "newworld:p1",
          storeId: "newworld:nw-1",
        }),
        "not json",
        record({ type: "product", productId: "paknsave:p2" }),
      ]);

      const first = await purgeArchive(file, "newworld");
      assert.equal(first.purged, 2);
      assert.equal(first.kept, 2);
      assert.equal(first.invalidLines, 1);

      const purged = (await readFile(file, "utf8")).trim().split("\n");
      assert.equal(purged.length, 2);
      assert.ok(!purged.join("").includes("newworld"));

      // Backup preserves the pre-purge contents (4 records + 1 invalid line).
      const backup = (await readFile(first.backupPath, "utf8")).trim().split("\n");
      assert.equal(backup.length, 5);

      // Second run is a no-op but still takes a backup first.
      const second = await purgeArchive(file, "newworld");
      assert.equal(second.purged, 0);
      assert.equal(second.kept, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses the live archive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "purge-breadth-live-"));
    try {
      const file = join(dir, "prices.jsonl");
      await writeFileFixture(file, [record({ storeId: "newworld:nw-1" })]);
      const previous = process.env.ARCHIVE_FILE;
      process.env.ARCHIVE_FILE = file;
      try {
        await assert.rejects(
          () => purgeArchive(file, "newworld"),
          /Refusing to purge/,
        );
      } finally {
        if (previous === undefined) delete process.env.ARCHIVE_FILE;
        else process.env.ARCHIVE_FILE = previous;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

