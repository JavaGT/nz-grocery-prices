import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PriceArchive } from "../src/archive.js";
import { JsonlObservationRepository } from "../src/repository.js";

console.warn("DEPRECATED: Use 'npm start' for the new price-minder server at src/app/server.js. The dashboard/ server is preserved as fallback only.");

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, "public");
const DATA_FILE = process.env.PRICE_FILE || join(__dirname, "..", "data", "prices.jsonl");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

const repository = new JsonlObservationRepository(DATA_FILE);
const archive = new PriceArchive(repository);

function json(res, data, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(res, status, message) {
  json(res, { error: message }, status);
}

function parseQuery(url) {
  const q = {};
  const params = new URL(url, "http://localhost").searchParams;
  for (const [k, v] of params) {
    if (["minDropPercent", "minSamples", "limit", "offset", "baselineDays", "freshDays"].includes(k)) {
      q[k] = Number(v);
    } else {
      q[k] = v;
    }
  }
  return q;
}

async function serveStatic(res, pathname) {
  try {
    const filePath = join(PUBLIC, pathname === "/" ? "index.html" : pathname);
    const ext = extname(filePath);
    const contentType = MIME[ext] || "application/octet-stream";
    const content = await readFile(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch (e) {
    if (e.code === "ENOENT") {
      try {
        const content = await readFile(join(PUBLIC, "index.html"));
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(content);
      } catch {
        sendError(res, 404, "Not found");
      }
    } else {
      sendError(res, 500, "Internal error");
    }
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const pathname = url.pathname;

  try {
    if (pathname === "/api/feed") {
      const q = parseQuery(req.url);
      const feed = await archive.agentFeed({
        retailer: q.retailer,
        storeId: q.storeId,
        minDropPercent: q.minDropPercent ?? 10,
        baselineDays: q.baselineDays ?? 90,
        freshWithinDays: q.freshDays ?? 7,
        minSamples: q.minSamples ?? 2,
      });
      const limit = q.limit || 100;
      if (feed.ongoingSales.length > limit) {
        feed.ongoingSales = feed.ongoingSales.slice(0, limit);
      }
      if (feed.sales.length > limit) {
        feed.sales = feed.sales.slice(0, limit);
      }
      return json(res, feed);
    }

    if (pathname === "/api/products") {
      const q = parseQuery(req.url);
      const observations = await archive.history({ retailer: q.retailer });
      const productMap = new Map();
      for (const obs of observations) {
        const existing = productMap.get(obs.product.id);
        if (!existing || obs.observedAt > existing.lastSeen) {
          productMap.set(obs.product.id, {
            id: obs.product.id,
            name: obs.product.name,
            brand: obs.product.brand,
            categories: obs.product.categories,
            images: obs.product.images,
            retailer: obs.store.retailer,
            storeId: obs.store.id,
            storeName: obs.store.name,
            lastSeen: obs.observedAt,
          });
        }
      }
      let products = [...productMap.values()];

      if (q.query) {
        const search = q.query.toLowerCase();
        products = products.filter(p =>
          p.name.toLowerCase().includes(search) ||
          (p.brand && p.brand.toLowerCase().includes(search))
        );
      }

      products.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));

      const total = products.length;
      const offset = q.offset || 0;
      const limit = q.limit || 50;
      products = products.slice(offset, offset + limit);

      return json(res, { products, total, offset, limit });
    }

    const historyMatch = pathname.match(/^\/api\/products\/(.+)\/history$/);
    if (historyMatch) {
      const productId = decodeURIComponent(historyMatch[1]);
      const [history, revisions] = await Promise.all([
        archive.history({ productId }),
        archive.productHistory(productId),
      ]);
      return json(res, { history, revisions });
    }

    if (pathname === "/api/stores") {
      const observations = await archive.history();
      const storeMap = new Map();
      for (const obs of observations) {
        const key = `${obs.store.id}:${obs.store.retailer}`;
        if (!storeMap.has(key)) {
          storeMap.set(key, obs.store);
        }
      }
      return json(res, [...storeMap.values()]);
    }

    if (pathname === "/api/stats") {
      const observations = await archive.history();
      const products = new Set();
      const stores = new Map();
      const retailers = new Set();
      let latest = null;
      let earliest = null;

      for (const obs of observations) {
        products.add(obs.product.id);
        stores.set(obs.store.id, obs.store);
        retailers.add(obs.store.retailer);
        const t = new Date(obs.observedAt).getTime();
        if (!latest || t > latest) latest = t;
        if (!earliest || t < earliest) earliest = t;
      }

      return json(res, {
        totalObservations: observations.length,
        totalProducts: products.size,
        totalStores: stores.size,
        stores: [...stores.values()],
        retailers: [...retailers],
        dateRange: {
          earliest: earliest ? new Date(earliest).toISOString() : null,
          latest: latest ? new Date(latest).toISOString() : null,
        },
      });
    }

    await serveStatic(res, pathname);
  } catch (e) {
    console.error(e);
    sendError(res, 500, "Internal server error");
  }
});

const PORT = process.env.DASHBOARD_PORT || process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`NZ Grocery Prices dashboard → http://localhost:${PORT}`);
});