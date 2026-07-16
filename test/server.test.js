import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { createServer, createConnection } from "node:net";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DASHBOARD = join(__dirname, "..", "dashboard", "server.js");

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function waitForPort(port, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
      const sock = createConnection({ port, host: "127.0.0.1" }, () => {
        sock.destroy();
        resolve();
      });
      sock.on("error", () => {
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`dashboard did not start on ${port} within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 100);
        }
      });
    }
    attempt();
  });
}

const records = [
  { version: 2, type: "product", productId: "paknsave:milk-1l",
    hash: "a".repeat(64), observedAt: "2026-07-01T10:00:00.000Z",
    data: { id: "paknsave:milk-1l", name: "Anchor Blue Milk 1L", brand: "Anchor",
      categories: ["Dairy"], size: "1L", image_url: null, source_id: null, gtin: "94171006" } },
  { version: 2, type: "store", storeId: "paknsave:royaloak",
    hash: "b".repeat(64), observedAt: "2026-07-01T10:00:00.000Z",
    data: { id: "paknsave:royaloak", name: "PAK'nSAVE Royal Oak", retailer: "paknsave",
      address: "Royal Oak, Auckland", region: "Auckland" } },
  { version: 2, type: "offer", offerId: "paknsave:milk-1l\u0000paknsave:royaloak",
    productId: "paknsave:milk-1l", storeId: "paknsave:royaloak",
    hash: "c".repeat(64), observedAt: "2026-07-15T12:00:00.000Z",
    data: { price: { regularCents: 350, promoCents: 280, memberCents: null },
      source: { retailerProductId: "milk-1l", adapter: "test", url: "https://example.com/p" },
      promotion: { type: "SPECIAL", savePercent: 20, startsAt: "2026-07-14T00:00:00.000Z" } } },
  { version: 2, type: "offer", offerId: "paknsave:milk-1l\u0000paknsave:royaloak",
    productId: "paknsave:milk-1l", storeId: "paknsave:royaloak",
    hash: "d".repeat(64), observedAt: "2026-07-01T12:00:00.000Z",
    data: { price: { regularCents: 350, promoCents: null, memberCents: null },
      source: { retailerProductId: "milk-1l", adapter: "test", url: "https://example.com/p" } } },
  { version: 2, type: "offer", offerId: "paknsave:milk-1l\u0000paknsave:royaloak",
    productId: "paknsave:milk-1l", storeId: "paknsave:royaloak",
    hash: "e".repeat(64), observedAt: "2026-06-15T12:00:00.000Z",
    data: { price: { regularCents: 360, promoCents: null, memberCents: null },
      source: { retailerProductId: "milk-1l", adapter: "test", url: "https://example.com/p" } } },
];

let port, dir, child, BASE;

before(async () => {
  port = await freePort();
  BASE = `http://127.0.0.1:${port}`;
  dir = await mkdtemp(join(tmpdir(), "dashboard-test-"));
  const jsonl = join(dir, "prices.jsonl");
  await writeFile(jsonl, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  child = spawn(process.execPath, [DASHBOARD], {
    env: { ...process.env, DASHBOARD_PORT: String(port), PRICE_FILE: jsonl },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {});
  child.stderr.on("data", () => {});
  await waitForPort(port);
});

after(async () => {
  if (child) child.kill("SIGTERM");
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe("Dashboard server API (self-contained)", () => {
  it("GET / returns HTML dashboard page", async () => {
    const res = await fetch(`${BASE}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>NZ Grocery Prices/);
    assert.match(html, /id="main-content"/);
  });

  it("GET /api/stores returns store list", async () => {
    const res = await fetch(`${BASE}/api/stores`);
    assert.equal(res.status, 200);
    const stores = await res.json();
    assert(Array.isArray(stores));
    assert(stores.length > 0);
    assert(stores[0].id);
    assert(stores[0].retailer);
    assert(stores[0].name);
  });

  it("GET /api/stats returns stats object", async () => {
    const res = await fetch(`${BASE}/api/stats`);
    assert.equal(res.status, 200);
    const stats = await res.json();
    assert("totalObservations" in stats);
    assert("totalProducts" in stats);
    assert("retailers" in stats);
    assert(Array.isArray(stats.retailers));
    assert(stats.totalObservations > 0);
  });

  it("GET /api/feed returns feed with ongoingSales and sales", async () => {
    const res = await fetch(`${BASE}/api/feed?minDropPercent=5&at=2026-07-16T00:00:00.000Z`);
    assert.equal(res.status, 200);
    const feed = await res.json();
    assert("generatedAt" in feed);
    assert.equal(feed.currency, "NZD");
    assert(Array.isArray(feed.ongoingSales));
    assert(Array.isArray(feed.sales));
    assert(feed.ongoingSales.length > 0);
    const item = feed.ongoingSales[0];
    assert(item.productId);
    assert(item.productName);
    assert(item.retailer);
    assert(typeof item.currentCents === "number");
    assert(item.savePercent != null);
  });

  it("GET /api/feed respects limit parameter", async () => {
    const at = "2026-07-16T00:00:00.000Z";
    const full = await (await fetch(`${BASE}/api/feed?minDropPercent=5&limit=5&at=${at}`)).json();
    assert(full.ongoingSales.length <= 5);
    const huge = await (await fetch(`${BASE}/api/feed?minDropPercent=5&limit=9999&at=${at}`)).json();
    assert(huge.ongoingSales.length <= 9999);
  });

  it("GET /api/products returns paginated products", async () => {
    const res = await fetch(`${BASE}/api/products?limit=5&offset=0`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert("products" in data);
    assert("total" in data);
    assert.equal(data.limit, 5);
    assert(data.products.length <= 5);
    assert(data.products[0].id);
    assert(data.products[0].name);
  });

  it("GET /api/products?query= filters products by name", async () => {
    const res = await fetch(`${BASE}/api/products?query=milk&limit=3`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert(data.products.length > 0);
    for (const p of data.products) {
      assert.match(p.name.toLowerCase(), /milk/);
    }
  });

  it("GET /api/products/:productId/history returns product history", async () => {
    const listRes = await fetch(`${BASE}/api/products?limit=1`);
    const list = await listRes.json();
    const pid = list.products[0].id;

    const res = await fetch(`${BASE}/api/products/${encodeURIComponent(pid)}/history`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert("history" in data);
    assert("revisions" in data);
    assert(Array.isArray(data.history));
  });

  it("GET /nonexistent.css falls back to index.html (SPA)", async () => {
    const res = await fetch(`${BASE}/nonexistent.css`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /id="app"/);
  });

  it("Dashboard serves app.js module", async () => {
    const res = await fetch(`${BASE}/app.js`);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /import.*from/);
  });
});
