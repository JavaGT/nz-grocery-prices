import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BASE = "http://localhost:7070";

describe("Dashboard server API", () => {
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
    const res = await fetch(`${BASE}/api/feed?minDropPercent=5`);
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
    const full = await (await fetch(`${BASE}/api/feed?minDropPercent=5&limit=5`)).json();
    assert(full.ongoingSales.length <= 5);
    const huge = await (await fetch(`${BASE}/api/feed?minDropPercent=5&limit=9999`)).json();
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
    // First get a product ID
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
