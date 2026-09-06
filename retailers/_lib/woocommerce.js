/**
 * WooCommerce Store API adapter for the retailers/ campaign.
 *
 * WooCommerce sites expose a public read-only Store API at
 * /wp-json/wc/store/v1/products (per_page/page pagination, collection
 * params). Prices arrive as minor-unit strings with an explicit currency;
 * sale items carry both regular and sale prices.
 */

import { getJson } from "./http.js";
import { buildObservation, minorUnitsToCents } from "./observation.js";

/**
 * Pure: extract the products array from a Store API response. WP REST error
 * bodies arrive as JSON objects with HTTP 200 (e.g. {code:"rest_no_route"}),
 * so a non-array body is a named error, never an "items is not iterable"
 * crash deep in the page walk.
 */
export function parseWooProducts(json, { operation = "woo products" } = {}) {
  if (Array.isArray(json)) return json;
  const code = typeof json?.code === "string" ? ` (${json.code})` : "";
  throw new TypeError(
    `${operation}: expected a products array, got ${typeof json}${code}`,
  );
}

/**
 * Pure: map one Store API product to a buildObservation spec. Prices are
 * minor-unit strings ("2499" = $24.99).
 */
export function mapWooProduct(item, store) {
  const prices = item?.prices ?? {};
  const minorUnit = Number(prices.currency_minor_unit ?? 2);
  const current = minorUnitsToCents(prices.price, minorUnit);
  if (!item?.id || !item?.name || current === undefined || current <= 0) return undefined;
  const regular = minorUnitsToCents(prices.regular_price, minorUnit);
  const sale = minorUnitsToCents(prices.sale_price, minorUnit);
  const hasPromo =
    regular !== undefined && sale !== undefined && sale < regular;
  const image = Array.isArray(item?.images) ? item.images[0]?.src ?? undefined : undefined;
  return {
    slug: store.retailer,
    storeId: store.scopeId,
    storeName: store.name,
    origin: store.origin,
    retailerProductId: String(item.id),
    url: item?.permalink,
    name: item.name,
    description: typeof item?.short_description === "string" ? item.short_description : undefined,
    image,
    regularCents: hasPromo ? regular : current,
    ...(hasPromo ? { promoCents: current } : {}),
  };
}

export class WooStoreClient {
  constructor(options = {}) {
    if (!options.slug || !options.origin) {
      throw new TypeError("WooStoreClient requires slug and origin");
    }
    this.origin = options.origin.replace(/\/$/, "");
    this.slug = options.slug;
    this.scopeId = options.scopeId ?? "online";
    this.scopeName = options.scopeName ?? options.slug;
    this.apiPath = options.apiPath ?? "/wp-json/wc/store/v1/products";
    this.pageSize = options.pageSize ?? 50;
    this.mapItem = options.mapItem ?? mapWooProduct;
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

  async listProducts({ page = 1, perPage = this.pageSize, category } = {}) {
    const url = new URL(`${this.origin}${this.apiPath}`);
    url.searchParams.set("per_page", String(perPage));
    url.searchParams.set("page", String(page));
    if (category) url.searchParams.set("category", String(category));
    return getJson(url, {
      fetch: this.#fetch,
      headers: this.headers,
      timeout: this.#timeout,
      operation: `woo ${this.slug} p${page}`,
    });
  }

  /** Walk pages until a short/empty page; dedupe by product id. */
  async collectProducts({ maxPages = 20, observedAt } = {}) {
    const store = this.getStore();
    const seen = new Set();
    const observations = [];
    for (let page = 1; page <= maxPages; page += 1) {
      let items;
      try {
        items = parseWooProducts(await this.listProducts({ page }), {
          operation: `woo ${this.slug} p${page}`,
        });
      } catch (error) {
        if (page === 1) {
          console.error(`woo ${this.slug}: list failed: ${error.message}`);
          return observations;
        }
        throw error;
      }
      let fresh = 0;
      for (const item of items) {
        const spec = this.mapItem(item, store);
        if (!spec) continue;
        const key = spec.retailerProductId;
        if (seen.has(key)) continue;
        seen.add(key);
        const observation = buildObservation({ ...spec, observedAt });
        if (observation) {
          observations.push(observation);
          fresh += 1;
        }
      }
      if (items.length < this.pageSize) break;
      if (fresh === 0) break;
    }
    return observations;
  }
}
