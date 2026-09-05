/**
 * IKEA New Zealand — NZ online store (ikea.com/nz).
 *
 * Platform: IKEA's global search service (sik.search.blue.cdtapps.com).
 * The endpoint is public: letter/category sweeps of search-result-page
 * cover the ~6.5k product catalog with NZD salesPrice data; the API caps
 * at one page per query, so the adapter sweeps a query set and dedupes.
 * Verified live 2026-09-06 (see README.md).
 */

import { getText } from "../_lib/http.js";
import { buildObservation } from "../_lib/observation.js";

export const RETAILER = {
  slug: "ikea",
  name: "IKEA New Zealand",
  origin: "https://www.ikea.com/nz/en",
  platform: "ikea-search",
};

const SEARCH_API = "https://sik.search.blue.cdtapps.com/nz/en/search-result-page";
const PAGE_SIZE = 48;

/** Query sweep: letters (catalog order is name-based) + common terms. */
export const QUERY_SWEEP = [
  "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l", "m",
  "n", "o", "p", "s", "t", "v", "w",
  "bed", "chair", "desk", "sofa", "table", "storage", "lamp", "kitchen", "shelf", "rug",
];

/** Pure: map one IKEA product payload to a buildObservation spec. */
export function mapIkeaProduct(product, store) {
  const price = Number(product?.salesPrice?.numeral);
  const regularCents = Number.isFinite(price) && price > 0 ? Math.round(price * 100) : undefined;
  if (!product?.id || !product?.name || regularCents === undefined) return undefined;
  return {
    slug: store.retailer,
    storeId: store.scopeId,
    storeName: store.name,
    origin: store.origin,
    retailerProductId: String(product.id),
    url: product.pipUrl,
    name: product.name,
    image: product.mainImageUrl,
    regularCents,
  };
}

export class IkeaSearchClient {
  constructor(options = {}) {
    this.slug = options.slug ?? RETAILER.slug;
    this.origin = options.origin ?? RETAILER.origin;
    this.scopeId = options.scopeId ?? "online";
    this.scopeName = options.scopeName ?? "IKEA NZ Online";
    this.queries = options.queries ?? QUERY_SWEEP;
    this.pageSize = options.pageSize ?? PAGE_SIZE;
    this.mapProduct = options.mapProduct ?? mapIkeaProduct;
    this.headers = { "user-agent": options.userAgent ?? undefined, accept: "application/json", ...options.headers };
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = options.timeout ?? 25000;
  }
  #fetch;
  #timeout;

  getStore() {
    return {
      id: `${this.slug}:${this.scopeId}`,
      retailer: this.slug,
      scopeId: this.scopeId,
      name: this.scopeName,
      origin: this.origin,
    };
  }

  async search(query) {
    const url = `${SEARCH_API}?q=${encodeURIComponent(query)}&size=${this.pageSize}`;
    const response = await this.#fetch(url, { headers: this.headers });
    if (!response.ok) throw new Error(`ikea search "${query}" failed: ${response.status}`);
    const json = await response.json();
    return (json?.searchResultPage?.products?.main?.items ?? [])
      .map((item) => item?.product)
      .filter(Boolean);
  }

  /**
   * Sweep the query set and map products. The API returns one page per
   * query, so coverage comes from the sweep breadth; results dedupe by
   * product id.
   */
  async collectProducts({ observedAt } = {}) {
    const store = this.getStore();
    const seen = new Set();
    const observations = [];
    for (const query of this.queries) {
      let products;
      try {
        products = await this.search(query);
      } catch (error) {
        console.error(`ikea: skipping query "${query}": ${error.message}`);
        continue;
      }
      for (const product of products) {
        const spec = this.mapProduct(product, store);
        if (!spec) continue;
        const key = `${store.retailer}:${spec.retailerProductId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const observation = buildObservation({ ...spec, observedAt });
        if (observation) observations.push(observation);
      }
    }
    return observations;
  }
}

export function createClient(options = {}) {
  return new IkeaSearchClient(options);
}
