/**
 * Magento 2 GraphQL adapter for the retailers/ campaign.
 *
 * Some NZ Magento storefronts expose a working POST /graphql (unlike the
 * dead headless scopes other sites serve). Categories resolve by url_key
 * to a numeric id, then products paginate with filter category_id. Multi
 * -store backends need a `Store: <code>` header (e.g. the shared Briscoes/
 * Rebel Sport platform).
 */

import { BROWSER_UA } from "./http.js";
import { fetchWithRetry, parseJsonResponse } from "../../src/adapters/fetch-with-retry.js";
import { buildObservation, toCents } from "./observation.js";

const CATEGORY_TREE_QUERY = `{
  categories {
    items {
      id
      name
      url_key
      children { id name url_key product_count }
    }
  }
}`;

const PRODUCTS_BY_CATEGORY_QUERY = `query($categoryId: String, $page: Int, $pageSize: Int) {
  products(filter: { category_id: { eq: $categoryId } }, currentPage: $page, pageSize: $pageSize, sort: { name: ASC }) {
    total_count
    items {
      id
      sku
      name
      url_key
      price_range {
        minimum_price {
          final_price { value }
          regular_price { value }
          discount { amount_off percent_off }
        }
      }
      small_image { url }
    }
  }
}`;

/** Pure: map a standard Magento product item to an observation spec. */
export function mapMagentoItem(item, store) {
  const current = toCents(Number(item?.price_range?.minimum_price?.final_price?.value));
  const regular = toCents(Number(item?.price_range?.minimum_price?.regular_price?.value));
  if (!item?.id || !item?.name || current === undefined || current <= 0) return undefined;
  return {
    slug: store.retailer,
    storeId: store.scopeId,
    storeName: store.name,
    origin: store.origin,
    retailerProductId: String(item.id),
    url: item.url_key ? `${store.origin}/${item.url_key}` : undefined,
    name: item.name,
    sku: item.sku ? String(item.sku) : undefined,
    image: item?.small_image?.url ?? undefined,
    regularCents: regular !== undefined && regular > current ? regular : current,
    ...(regular !== undefined && regular > current ? { promoCents: current } : {}),
  };
}

export class MagentoGraphqlClient {
  constructor(options = {}) {
    if (!options.slug || !options.origin) {
      throw new TypeError("MagentoGraphqlClient requires slug and origin");
    }
    if (!Array.isArray(options.categories) || options.categories.length === 0) {
      throw new TypeError("MagentoGraphqlClient requires categories: [urlKey, ...]");
    }
    this.origin = options.origin.replace(/\/$/, "");
    this.slug = options.slug;
    this.scopeId = options.scopeId ?? "online";
    this.scopeName = options.scopeName ?? options.slug;
    this.storeCode = options.storeCode;
    this.categories = options.categories;
    this.pageSize = options.pageSize ?? 100;
    this.mapItem = options.mapItem ?? mapMagentoItem;
    this.headers = {
      "content-type": "application/json",
      "user-agent": options.userAgent ?? BROWSER_UA,
      ...(this.storeCode ? { store: this.storeCode } : {}),
      ...Object.fromEntries(Object.entries(options.headers ?? {}).filter(([, v]) => v !== undefined)),
    };
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

  async graphql(query, variables = {}) {
    const response = await fetchWithRetry(this.origin + "/graphql", {
      fetch: this.#fetch,
      timeout: this.#timeout,
      retry: this.#retry,
      method: "POST",
      headers: { ...this.headers, "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    if (!response.ok) {
      throw new Error(`graphql ${this.slug} failed: ${response.status} ${response.statusText}`);
    }
    // parseJsonResponse (not raw response.json()) so a WAF challenge
    // served with status 200 fails with an error naming the retailer,
    // status, content-type, and body prefix instead of a bare SyntaxError.
    const json = await parseJsonResponse(response, `graphql ${this.slug}`);
    if (json.errors?.length) {
      throw new Error(`graphql ${this.slug} errors: ${json.errors.map((e) => e.message).join("; ")}`);
    }
    return json.data;
  }

  /** Root category children as { id, url_key, name, product_count }.
   * Null/junk entries are dropped so a malformed tree cannot crash the
   * url_key map in collectProducts. */
  async listCategoryTree() {
    const data = await this.graphql(CATEGORY_TREE_QUERY);
    const out = [];
    for (const root of data?.categories?.items ?? []) {
      for (const child of root?.children ?? []) {
        if (child?.url_key) out.push(child);
      }
    }
    return out;
  }

  async listCategoryPage(categoryId, page) {
    const data = await this.graphql(PRODUCTS_BY_CATEGORY_QUERY, {
      categoryId,
      page,
      pageSize: this.pageSize,
    });
    return {
      total: data?.products?.total_count ?? 0,
      items: data?.products?.items ?? [],
    };
  }

  /**
   * Resolve each configured category url_key to its id, then paginate its
   * products until the declared total is walked or pages stop producing.
   */
  async collectProducts({ maxPages = 50, observedAt } = {}) {
    const store = this.getStore();
    const tree = await this.listCategoryTree();
    const byKey = new Map(tree.map((c) => [c.url_key, c]));
    const seen = new Set();
    const observations = [];
    for (const urlKey of this.categories) {
      const category = byKey.get(urlKey);
      if (!category) {
        console.error(`magento-graphql ${this.slug}: category ${urlKey} not found`);
        continue;
      }
      const expected = Math.min(Number(category.product_count) || 0, maxPages * this.pageSize);
      let collected = 0;
      for (let page = 1; page <= maxPages && collected < expected; page += 1) {
        let result;
        try {
          result = await this.listCategoryPage(String(category.id), page);
        } catch (error) {
          console.error(`magento-graphql ${this.slug}: ${urlKey} page ${page}: ${error.message}`);
          break;
        }
        let fresh = 0;
        for (const item of result.items) {
          if (seen.has(item.id)) continue;
          seen.add(item.id);
          const spec = this.mapItem(item, store);
          const observation = spec ? buildObservation({ ...spec, observedAt }) : undefined;
          if (observation) {
            observations.push(observation);
            fresh += 1;
          }
        }
        collected += result.items.length;
        if (fresh === 0 && result.items.length === 0) break;
      }
    }
    return observations;
  }
}
