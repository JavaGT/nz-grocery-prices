/**
 * Algolia search-index adapter for the retailers/ campaign.
 *
 * Several NZ retailers expose their product catalog through a public
 * Algolia index (app id + search key embedded in their storefront JS). The
 * REST endpoint accepts GET with query params, so the hardened getJson
 * seam works as-is. An empty query browses the whole index, which is the
 * campaign's full-catalog walk. Hit shapes differ per retailer, so the
 * mapping is a per-retailer `mapHit(hit)` returning buildObservation specs.
 */

import { getJson } from "./http.js";
import { buildObservation } from "./observation.js";

export function parseAlgoliaHits(json) {
  return Array.isArray(json?.hits) ? json.hits : [];
}

/**
 * `mapHit(hit, store)` returns either a full observation or the spec fields
 * for buildObservation (undefined drops the hit). Dedupes by product id.
 */
export function toAlgoliaObservations(hits, store, mapHit, options = {}) {
  const seen = new Set();
  const observations = [];
  for (const hit of hits) {
    const spec = mapHit(hit, store);
    if (!spec) continue;
    const observation = buildObservation({
      slug: store.retailer,
      storeId: store.scopeId,
      storeName: store.name,
      origin: store.origin,
      observedAt: options.observedAt,
      ...spec,
    });
    if (!observation || seen.has(observation.product.id)) continue;
    seen.add(observation.product.id);
    observations.push(observation);
  }
  return observations;
}

export class AlgoliaSearchClient {
  constructor(options = {}) {
    if (!options.appId || !options.apiKey || !options.indexName) {
      throw new TypeError("AlgoliaSearchClient requires appId, apiKey, indexName");
    }
    if (!options.slug || !options.origin) {
      throw new TypeError("AlgoliaSearchClient requires slug and origin");
    }
    if (typeof options.mapHit !== "function") {
      throw new TypeError("AlgoliaSearchClient requires mapHit(hit, store)");
    }
    this.appId = options.appId;
    this.apiKey = options.apiKey;
    this.indexName = options.indexName;
    this.slug = options.slug;
    this.scopeId = options.scopeId ?? "online";
    this.scopeName = options.scopeName ?? options.slug;
    this.origin = options.origin.replace(/\/$/, "");
    this.pageSize = options.pageSize ?? 1000;
    // Slice-walk config for indexes with a pagination cap:
    // sliceAttribute names a numeric hit field (e.g. "Id"), sliceStep its
    // range width per query, sliceFrom the starting lower bound.
    this.sliceAttribute = options.sliceAttribute;
    this.sliceStep = options.sliceStep ?? 500;
    this.sliceFrom = options.sliceFrom ?? 0;
    this.mapHit = options.mapHit;
    this.headers = { "user-agent": options.userAgent ?? undefined, ...options.headers };
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

  #endpoint() {
    return new URL(`https://${this.appId.toLowerCase()}-dsn.algolia.net/1/indexes/${encodeURIComponent(this.indexName)}`);
  }

  /** One search page. `query: ""` browses the full index in index order. */
  async search({ query = "", page = 0, hitsPerPage = this.pageSize, numericFilters } = {}) {
    const url = this.#endpoint();
    url.searchParams.set("query", query);
    url.searchParams.set("page", String(page));
    url.searchParams.set("hitsPerPage", String(hitsPerPage));
    if (numericFilters) url.searchParams.set("numericFilters", numericFilters);
    return getJson(url, {
      fetch: this.#fetch,
      headers: {
        "x-algolia-application-id": this.appId,
        "x-algolia-api-key": this.apiKey,
        ...this.headers,
      },
      timeout: this.#timeout,
      retry: this.#retry,
      operation: `algolia ${this.slug} ${this.indexName} p${page}`,
    });
  }

  /**
   * Walk the whole index. Many retailer indexes set Algolia's
   * paginationLimitedTo (~1000), which hides everything past the first
   * ~1000 records; when `sliceAttribute` is configured the walk instead
   * slides a numeric range over a numeric field (e.g. "Id") so every slice
   * paginates within the cap. Slices returning nothing are skipped; the
   * walk ends after a few consecutive empty slices past the highest id seen.
   */
  async collectProducts({ maxPages = Number.POSITIVE_INFINITY, observedAt } = {}) {
    const store = this.getStore();
    const all = [];
    if (this.sliceAttribute) {
      const step = this.sliceStep ?? 500;
      let lo = this.sliceFrom ?? 0;
      let highestSeen = 0;
      let emptyRun = 0;
      while (emptyRun < 3 && lo <= highestSeen + step * 3) {
        let page = 0;
        let sliceMax = -1;
        for (page = 0; page < maxPages; page += 1) {
          const numericFilters = `${this.sliceAttribute}>${lo},${this.sliceAttribute}<=${lo + step}`;
          const result = await this.search({ page, numericFilters });
          const hits = parseAlgoliaHits(result);
          if (hits.length === 0) break;
          all.push(...hits);
          for (const hit of hits) {
            const id = Number(hit[this.sliceAttribute]);
            if (Number.isFinite(id)) {
              sliceMax = Math.max(sliceMax, id);
              highestSeen = Math.max(highestSeen, id);
            }
          }
          const lastPage = (result.nbPages ?? 1) - 1;
          if (page >= lastPage) break;
        }
        if (sliceMax === -1) emptyRun += 1;
        else emptyRun = 0;
        lo += step;
      }
    } else {
      let page = 0;
      for (;;) {
        const result = await this.search({ page, hitsPerPage: this.pageSize });
        const hits = parseAlgoliaHits(result);
        if (hits.length === 0) break;
        all.push(...hits);
        page += 1;
        const lastPage = (result.nbPages ?? 1) - 1;
        if (page > lastPage || page >= maxPages) break;
      }
    }
    return toAlgoliaObservations(all, store, this.mapHit, { observedAt });
  }
}
