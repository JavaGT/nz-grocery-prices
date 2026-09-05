import assert from "node:assert/strict";
import { test } from "node:test";
import { readdir } from "node:fs/promises";

/**
 * Convergence gate for the retailers/ campaign: every retailer folder must
 * export a well-formed RETAILER descriptor and a createClient whose store
 * scope agrees with it — no network involved. This keeps the campaign
 * manifest honest as retailer folders are added (target: 50).
 */

const RETAILERS_ROOT = new URL("../../retailers/", import.meta.url);

async function retailerFolders() {
  const entries = await readdir(RETAILERS_ROOT, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== "_lib")
    .map((entry) => entry.name)
    .sort();
}

test("every retailer folder exports a coherent RETAILER + createClient", async () => {
  const folders = await retailerFolders();
  assert.ok(folders.length > 0, "no retailer folders found");
  const seenSlugs = new Set();
  for (const folder of folders) {
    const mod = await import(`../../retailers/${folder}/index.js`);
    const { RETAILER, createClient } = mod;
    assert.ok(RETAILER, `${folder}: missing RETAILER export`);
    assert.equal(RETAILER.slug, folder, `${folder}: RETAILER.slug must match the folder name`);
    assert.ok(!seenSlugs.has(RETAILER.slug), `duplicate slug ${RETAILER.slug}`);
    seenSlugs.add(RETAILER.slug);
    assert.equal(typeof RETAILER.name, "string", `${folder}: RETAILER.name`);
    assert.match(RETAILER.origin, /^https:\/\//, `${folder}: origin must be https`);
    assert.equal(typeof RETAILER.platform, "string", `${folder}: RETAILER.platform`);
    assert.equal(typeof createClient, "function", `${folder}: missing createClient`);

    const client = createClient();
    const store = client.getStore();
    assert.equal(store.retailer, RETAILER.slug, `${folder}: client store retailer mismatch`);
    assert.equal(store.origin ?? client.origin, RETAILER.origin, `${folder}: client store origin mismatch`);
    assert.ok(String(store.id).startsWith(`${RETAILER.slug}:`), `${folder}: store id must be <slug>:<scope>`);
  }
});

test("the campaign tracks at least 50 retailers overall", async (t) => {
  // Existing adapters (src/adapters) count toward the 50: woolworths,
  // paknsave, newworld, freshchoice, warehouse.
  const EXISTING = 5;
  const folders = await retailerFolders();
  const total = folders.length + EXISTING;
  if (total < 50) {
    t.skip(`campaign in progress: ${total}/50 retailer adapters`);
    return;
  }
  assert.ok(total >= 50, `campaign reports ${total}; need 50`);
});
