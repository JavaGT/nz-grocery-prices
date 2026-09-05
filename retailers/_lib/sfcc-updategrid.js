/**
 * Salesforce Commerce Cloud (SFCC) `updategrid` client for the retailers/
 * campaign.
 *
 * Classic SFCC storefronts (The Warehouse, Noel Leeming) render product
 * grids at GET /search/updategrid?cgid=<category>&start=<offset>&sz=<size>.
 * The tiles carry a data-gtm-product JSON payload parsed by the proven
 * parseWarehouseProducts transformer, so this family reuses src/adapters
 * rather than re-implementing the markup parser.
 */

import { getText } from "./http.js";
import { curlGetText } from "./curl-transport.js";
import { parseWarehouseProducts, toSfccObservation, totalGridItems } from "../../src/adapters/warehouse.js";

export function parseSfccGrid(html) {
  return parseWarehouseProducts(html);
}

export function toSfccObservations(products, store, options = {}) {
  return products
    .map((product) => toSfccObservation(product, store, { ...options, origin: store.origin }))
    .filter(Boolean);
}

export class SfccUpdateGridClient {
  constructor(options = {}) {
    if (!options.origin) throw new TypeError("SfccUpdateGridClient requires origin");
    if (!options.slug) throw new TypeError("SfccUpdateGridClient requires slug");
    if (!Array.isArray(options.categories) || options.categories.length === 0) {
      throw new TypeError("SfccUpdateGridClient requires categories: [\"cgid\", ...]");
    }
    this.origin = options.origin.replace(/\/$/, "");
    this.slug = options.slug;
    this.scopeId = options.scopeId ?? "online";
    this.scopeName = options.scopeName ?? options.slug;
    this.gridPath = options.gridPath ?? "/search/updategrid";
    this.categories = options.categories;
    this.pageSize = options.pageSize ?? 48;
    // Retailers like Noel Leeming fingerprint TLS and 403 Node's fetch, so
    // like the warehouse adapter the default transport is curl via
    // execFile; tests inject fetch and opt into the fetch transport.
    this.transport = options.transport ?? (options.fetch ? "fetch" : "curl");
    this.curlPath = options.curlPath ?? "curl";
    this.headers = {
      "user-agent": options.userAgent ?? undefined,
      accept: "text/html,application/xhtml+xml",
      referer: `${this.origin}/`,
      ...options.headers,
    };
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = options.timeout ?? 20000;
    this.#retry = options.retry;
  }
  #fetch;
  #timeout;
  #retry;

  getStore() {
    return {
      id: `${this.slug}:${this.scopeId}`,
      retailer: this.slug,
      scopeId: this.scopeId,
      name: this.scopeName,
      origin: this.origin,
    };
  }

  async listCategoryPage(cgid, page, pageSize = this.pageSize) {
    const url = new URL(this.gridPath, this.origin);
    url.searchParams.set("cgid", cgid);
    url.searchParams.set("start", String((page - 1) * pageSize));
    url.searchParams.set("sz", String(pageSize));
    if (this.transport === "curl") {
      return curlGetText(url.toString(), {
        headers: this.headers,
        userAgent: this.headers["user-agent"],
        curlPath: this.curlPath,
        timeoutMs: this.#timeout,
      });
    }
    return getText(url, {
      fetch: this.#fetch,
      headers: this.headers,
      timeout: this.#timeout,
      retry: this.#retry,
      operation: `sfcc ${this.slug} ${cgid} p${page}`,
    });
  }

  /**
   * Walk every configured category until a page contributes no fresh
   * product ids, then map the deduped tiles to validated observations.
   */
  async collectProducts({ maxPages = 100, observedAt } = {}) {
    const store = this.getStore();
    const seen = new Map(); // product id -> gtm payload
    for (const cgid of this.categories) {
      for (let page = 1; page <= maxPages; page += 1) {
        let html;
        try {
          html = await this.listCategoryPage(cgid, page);
        } catch (error) {
          if (page === 1) {
            console.error(`sfcc ${this.slug}: skipping category ${cgid}: ${error.message}`);
            break;
          }
          throw error;
        }
        const products = parseSfccGrid(html);
        let fresh = 0;
        for (const product of products) {
          if (!seen.has(product.id)) {
            seen.set(product.id, product);
            fresh += 1;
          }
        }
        // Fully-duplicate or empty page means we are past the category end.
        // A declared total protects against grids that loop their tail.
        const total = totalGridItems(html);
        if (fresh === 0 || (total !== undefined && page * this.pageSize >= total)) break;
      }
    }
    return toSfccObservations([...seen.values()], store, { observedAt });
  }
}
