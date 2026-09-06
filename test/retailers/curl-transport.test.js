import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { curlGetText } from "../../retailers/_lib/curl-transport.js";

/** Write an executable stand-in for the curl binary (no network involved). */
async function writeFakeCurl(body) {
  const dir = await mkdtemp(join(tmpdir(), "curl-transport-test-"));
  const path = join(dir, "fake-curl.sh");
  await writeFile(path, body);
  await chmod(path, 0o755);
  return path;
}

test("curlGetText builds the documented argv and returns stdout unchanged", async () => {
  // echo prints its argv back, pinning flag order/construction offline.
  const stdout = await curlGetText("https://shop.example/search", {
    curlPath: "echo",
    userAgent: "agent/1.0",
    headers: { accept: "application/json" },
    timeoutMs: 1000,
  });
  assert.match(stdout, /--silent --show-error --fail-with-body --location --compressed/);
  assert.match(stdout, /--max-time 1/);
  assert.match(stdout, /--user-agent agent\/1\.0/);
  assert.match(stdout, /--header accept: application\/json/);
  assert.ok(stdout.trim().endsWith("https://shop.example/search"));
});

test("curl failures surface exit code, stderr, and the --fail-with-body body", async () => {
  const curlPath = await writeFakeCurl(
    "#!/bin/sh\n" +
      "echo '<html>blocked by waf</html>'\n" +
      "echo 'curl: (22) The requested URL returned error: 403' >&2\n" +
      "exit 22\n",
  );
  await assert.rejects(
    curlGetText("https://shop.example/blocked", { curlPath }),
    (error) => {
      assert.match(error.message, /curl GET https:\/\/shop\.example\/blocked exit 22/);
      assert.match(error.message, /403/);
      assert.match(error.message, /blocked by waf/);
      return true;
    },
  );
});

test("the wedge-guard timeout kills a curl that outlives --max-time", async () => {
  const curlPath = await writeFakeCurl("#!/bin/sh\nsleep 30\n");
  const started = Date.now();
  await assert.rejects(
    curlGetText("https://shop.example/hang", { curlPath, timeoutMs: 200 }),
    (error) => error.message.includes("https://shop.example/hang"),
  );
  // Rejected by the execFile-level timeout (~max-time + 2s), not by sleep 30.
  assert.ok(Date.now() - started < 15000);
});
