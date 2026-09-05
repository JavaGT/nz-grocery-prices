/**
 * Constructor.io search-adapter for the retailers/ campaign.
 *
 * Some NZ storefronts (e.g. Kmart NZ) power product discovery with
 * Constructor.io — a search/browse API authenticated only by a public
 * site key published in their storefront bundles. The search endpoint
 * returns product records with name, url, brand, image, and per-variation
 * pricing metadata.
 */

import { buildObservation } from "./observation.js";

const CONSTRUCTOR_HOST = "https://ac.cnstrc.com";

/** Pure: extract results from a Constructor search response. */
export function parseConstructorResults(json) {
  return Array.isArray(json?.response?.results) ? json.response.results : [];
}

/**
 * Default result → buildObservation spec mapping:
 *   value (name), data.id ("P_43684687"), data.uri, data.Brand,
 *   data.image_url, variations[].data { price, prices[], apn }.
 */
export function mapConstructorItem(item, store) {
  const data = item?.data ?? {};
  const rawId = data.id ?? item?.id;
  const id = typeof rawId === "string" ? rawId.replace(/^P_/, "") : rawId;
  const name = item?.value;
  const price = Number(item?.variations?.[0]?.data?.price);
  const regularCents = Number.isFinite(price) && price > 0 ? Math.round(price * 100) : undefined;
  if (id === undefined || id === "" || !name || regularCents === undefined) return undefined;
  const listPrice = Number(
    item?.variations?.[0]?.data?.prices?.find?.((p) => p.type === "list")?.amount,
  );
  const listCents = Number.isFinite(listPrice) ? Math.round(listPrice * 100) : undefined;
  const gtin = String(item?.variations?.[0]?.data?.apn ?? "").replace(/\D/g, "");
  return {
    slug: store.retailer,
    storeId: store.scopeId,
    storeName: store.name,
    origin: store.origin,
    retailerProductId: String(id),
    url: data.uri ? `${store.origin}${data.uri}` : undefined,
    name,
    brand: typeof data.Brand === "string" && data.Brand ? data.Brand : undefined,
    gtin: gtin.length >= 8 && gtin.length <= 14 ? gtin : undefined,
    image: typeof data.image_url === "string" ? data.image_url : undefined,
    regularCents: listCents !== undefined && listCents > regularCents ? listCents : regularCents,
    ...(listCents !== undefined && listCents > regularCents ? { promoCents: regularCents } : {}),
  };
}

export class ConstructorSearchClient {
  constructor(options = {}) {
    if (!options.key) throw new TypeError("ConstructorSearchClient requires key");
    if (!options.slug || !options.origin) {
      throw new TypeError("ConstructorSearchClient requires slug and origin");
    }
    if (!Array.isArray(options.queries) || options.queries.length === 0) {
      throw new TypeError("ConstructorSearchClient requires queries: [term, ...]");
    }
    this.key = options.key;
    this.slug = options.slug;
    this.scopeId = options.scopeId ?? "online";
    this.scopeName = options.scopeName ?? options.slug;
    this.origin = options.origin.replace(/\/$/, "");
    this.queries = options.queries;
    this.pageSize = options.pageSize ?? 100;
    this.mapItem = options.mapItem ?? mapConstructorItem;
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

  async search(term, page = 1) {
    const url =
      `${CONSTRUCTOR_HOST}/search/${encodeURIComponent(term)}?key=${encodeURIComponent(this.key)}` +
      `&num_results_per_page=${this.pageSize}&page=${page}`;
    const response = await this.#fetch(url, { headers: this.headers });
    if (!response.ok) throw new Error(`constructor ${this.slug} "${term}" p${page} failed: ${response.status}`);
    return response.json();
  }

  /**
   * Sweep the query terms, paginating each until a short page, and map
   * results to validated observations (deduped by product id).
   */
  async collectProducts({ maxPagesPerQuery = 5, observedAt } = {}) {
    const store = this.getStore();
    const seen = new Set();
    const observations = [];
    for (const term of this.queries) {
      for (let page = 1; page <= maxPagesPerQuery; page += 1) {
        let json;
        try {
          json = await this.search(term, page);
        } catch (error) {
          if (page === 1) {
            console.error(`constructor ${this.slug}: skipping "${term}": ${error.message}`);
            break;
          }
          throw error;
        }
        const results = parseConstructorResults(json);
        let fresh = 0;
        for (const item of results) {
          const spec = this.mapItem(item, store);
          if (!spec) continue;
          const key = `${store.retailer}:${spec.retailerProductId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const observation = buildObservation({ ...spec, observedAt });
          if (observation) {
            observations.push(observation);
            fresh += 1;
          }
        }
        if (results.length < this.pageSize) break;
        if (fresh === 0) break;
      }
    }
    return observations;
  }
}
