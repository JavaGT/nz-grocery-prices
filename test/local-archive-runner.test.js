import assert from "node:assert/strict";
import { chmod, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const runner = resolve("scripts/archive-daily-local.sh");

function resolveHealthFile(archiveFile) {
  return join(archiveFile.replace(/\/[^/]+$/, ""), "collection-health.jsonl");
}

async function createFakeNpm(directory) {
  const fakeNpm = join(directory, "fake-npm.sh");
  const lines = [
    "#!/bin/sh",
    "set -eu",
    'command=""',
    'file=""',
    'for argument in "$@"; do',
    '  case "$argument" in paknsave|woolworths|newworld|freshchoice|warehouse) command="$argument";; esac',
    "done",
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--file" ]; then file="$2"; break; fi',
    "  shift",
    "done",
    '[ -n "$command" ] && [ -n "$file" ]',
    'if [ "${FAIL_COMMAND:-}" = "$command" ]; then exit 17; fi',
    'printf \'{"command":"%s"}\\n\' "$command" >> "$file"',
  ];
  await writeFile(fakeNpm, lines.join("\n") + "\n");
  await chmod(fakeNpm, 0o755);
  return fakeNpm;
}

async function runArchive({ failCommand } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "prices-local-archive-"));
  const archiveFile = join(directory, "prices.jsonl");
  await writeFile(archiveFile, '{"existing":true}\n');
  const fakeNpm = await createFakeNpm(directory);
  let result;
  try {
    result = await execFileAsync("sh", [runner], {
      env: { ...process.env, ARCHIVE_FILE: archiveFile, NPM_COMMAND: fakeNpm, FAIL_COMMAND: failCommand ?? "" },
    });
  } catch (error) {
    result = { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
  return { archiveFile, directory, ...result };
}

test("local archive runner publishes only after every collector succeeds", async () => {
  const { archiveFile, stdout, stderr } = await runArchive();
  assert.equal(stderr, "");
  assert.match(stdout, /archive collection completed/);
  const records = (await readFile(archiveFile, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(records, [
    { existing: true },
    { command: "paknsave" }, { command: "woolworths" }, { command: "newworld" },
    { command: "freshchoice" }, { command: "warehouse" },
  ]);

  const healthFile = resolveHealthFile(archiveFile);
  const healthContent = await readFile(healthFile, "utf8");
  const healthRecords = healthContent.trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.equal(healthRecords.length, 5);
  for (const rec of healthRecords) {
    assert.equal(rec.status, "success");
    assert.equal(rec.exitCode, 0);
    assert.ok(rec.startedAt);
    assert.ok(rec.endedAt);
    assert.ok(typeof rec.durationMs === "number");
    assert.ok(typeof rec.records === "number");
  }
  assert.deepEqual(healthRecords.map((r) => r.retailer), [
    "paknsave", "woolworths", "newworld", "freshchoice", "warehouse",
  ]);
});

test("local archive runner preserves the live archive after a collector failure", async () => {
  const { archiveFile, directory, code, stderr } = await runArchive({ failCommand: "newworld" });
  assert.equal(code, 17);
  assert.match(stderr, /archive collection failed/);
  assert.equal(await readFile(archiveFile, "utf8"), '{"existing":true}\n');
  const files = await readdir(directory);
  assert.equal(files.some((file) => file.includes(".tmp.") || file.endsWith(".collect.lock")), false);

  const healthFile = resolveHealthFile(archiveFile);
  const healthContent = await readFile(healthFile, "utf8");
  const healthRecords = healthContent.trim().split("\n").filter(Boolean).map(JSON.parse);
  assert.ok(healthRecords.length >= 3, "health records for paknsave, woolworths, newworld");
  assert.equal(healthRecords[0].retailer, "paknsave");
  assert.equal(healthRecords[0].status, "success");
  assert.equal(healthRecords[1].retailer, "woolworths");
  assert.equal(healthRecords[1].status, "success");
  assert.equal(healthRecords[2].retailer, "newworld");
  assert.equal(healthRecords[2].status, "failure");
  assert.equal(healthRecords[2].exitCode, 17);
  assert.ok(healthRecords[2].errorMessage !== undefined);
});

test("collection health file contains no secrets", async () => {
  const { archiveFile, stderr } = await runArchive();
  assert.equal(stderr, "");
  const healthFile = resolveHealthFile(archiveFile);
  const healthContent = await readFile(healthFile, "utf8");
  const healthRecords = healthContent.trim().split("\n").filter(Boolean).map(JSON.parse);
  for (const rec of healthRecords) {
    assert.ok(!rec.ts || typeof rec.ts === "string");
    assert.equal(typeof rec.retailer, "string");
    assert.ok(!rec.errorMessage || rec.errorMessage.length <= 500);
  }
});
