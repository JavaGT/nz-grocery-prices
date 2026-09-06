/**
 * Next.js __NEXT_DATA__ dehydrated-state adapter for the retailers/
 * campaign (react-query based storefronts, e.g. Bunnings NZ).
 *
 * Category pages embed their search results inside
 * `__NEXT_DATA__.props.pageProps.dehydratedState.queries` — the query
 * whose key starts with a configured marker (e.g. "category-search") holds
 * `{ state: { data: { results: { [i]: { raw: {...} } }, totalCount } } }`.
 */

import { getText } from "./http.js";
import { buildObservation } from "./observation.js";

/** Parse the __NEXT_DATA__ JSON blob from an SSR page. */
export function parseNextData(html) {
  if (typeof html !== "string") return undefined;
  const i = html.indexOf("__NEXT_DATA__");
  if (i === -1) return undefined;
  const start = html.indexOf(">", i);
  const end = html.indexOf("</script>", start);
  if (start === -1 || end === -1) return undefined;
  try {
    return JSON.parse(html.slice(start + 1, end));
  } catch {
    return undefined;
  }
}

/** Find the dehydrated react-query entry whose key starts with `marker`. */
export function findDehydratedQuery(json, marker) {
  const queries = json?.props?.pageProps?.dehydratedState?.queries;
  if (!Array.isArray(queries)) return undefined;
  return queries.find((q) => Array.isArray(q?.queryKey) && q.queryKey[0] === marker);
}

/**
 * Default raw-item → buildObservation spec mapping for Bunnings-style
 * Coveo `raw` records: { code, name, brandname, price, currency,
 * imageurl, productroutingurl }.
 */
export function mapRawItem(item, store) {
  const raw = item?.raw ?? item;
  const price = Number(raw?.price);
  const regularCents = Number.isFinite(price) && price > 0 ? Math.round(price * 100) : undefined;
  if (!raw?.code || !raw?.name || regularCents === undefined) return undefined;
  return {
    slug: store.retailer,
    storeId: store.scopeId,
    storeName: store.name,
    origin: store.origin,
    retailerProductId: String(raw.code),
    url: raw.productroutingurl ? `${store.origin}${raw.productroutingurl}` : undefined,
    name: raw.name,
    brand: typeof raw.brandname === "string" && raw.brandname ? raw.brandname : undefined,
    image: typeof raw.imageurl === "string" ? raw.imageurl : undefined,
    regularCents,
  };
}

export class NextDataClient {
  constructor(options = {}) {
    if (!options.slug || !options.origin) {
      throw new TypeError("NextDataClient requires slug and origin");
    }
    if (!Array.isArray(options.categories) || options.categories.length === 0) {
      throw new TypeError("NextDataClient requires categories: [path, ...]");
    }
    this.origin = options.origin.replace(/\/$/, "");
    this.slug = options.slug;
    this.scopeId = options.scopeId ?? "online";
    this.scopeName = options.scopeName ?? options.slug;
    this.categories = options.categories;
    this.queryMarker = options.queryMarker ?? "category-search";
    this.pageParam = options.pageParam ?? "page";
    this.pageSize = options.pageSize ?? 36;
    this.mapItem = options.mapItem ?? mapRawItem;
    this.headers = { "user-agent": options.userAgent ?? undefined, ...options.headers };
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = options.timeout ?? 25000;
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

  async listCategoryPage(category, page) {
    let url = `${this.origin}/${category.replace(/^\//, "")}`;
    if (page > 1) url += `${url.includes("?") ? "&" : "?"}${this.pageParam}=${page}`;
    const body = await getText(url, {
      fetch: this.#fetch,
      headers: this.headers,
      timeout: this.#timeout,
      retry: this.#retry,
      operation: `next ${this.slug} ${category} p${page}`,
    });
    const json = parseNextData(body);
    const query = json && findDehydratedQuery(json, this.queryMarker);
    const data = query?.state?.data;
    if (!data) return { items: [], total: undefined };
    const raw = data.results ?? {};
    const items = Object.values(raw).map((entry) => entry?.raw ?? entry);
    return { items, total: data.totalCount };
  }

  async collectProducts({ maxPages = 3, observedAt } = {}) {
    const store = this.getStore();
    const seen = new Set();
    const observations = [];
    for (const category of this.categories) {
      const label = category.split("?")[0].split("/").filter(Boolean).pop();
      const expected = maxPages * this.pageSize;
      let collected = 0;
      for (let page = 1; page <= maxPages && collected < expected; page += 1) {
        let result;
        try {
          result = await this.listCategoryPage(category, page);
        } catch (error) {
          if (page === 1) {
            console.error(`next ${this.slug}: skipping category ${category}: ${error.message}`);
            break;
          }
          throw error;
        }
        let fresh = 0;
        for (const item of result.items) {
          const spec = this.mapItem(item, store);
          if (!spec) continue;
          const key = `${store.retailer}:${spec.retailerProductId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          const observation = buildObservation({
            ...spec,
            observedAt,
            ...(label ? { categories: [label] } : {}),
          });
          if (observation) {
            observations.push(observation);
            fresh += 1;
          }
        }
        collected += result.items.length;
        if (result.items.length === 0) break;
      }
    }
    return observations;
  }
}
