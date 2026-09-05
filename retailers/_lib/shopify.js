/**
 * Shopify catalog adapter for the retailers/ campaign.
 *
 * Shopify storefronts expose the published catalog at
 * GET /products.json?limit=250&page=N (JSON, no auth). Prices are decimal
 * dollar strings per variant; compare_at_price marks the was-price.
 *
 * Some shops disable /products.json via redirects/apps but still allow
 * /collections/<handle>/products.json — listCollections/listCategory
 * cover that path. Verdicts per retailer live in retailers/<slug>/README.md.
 */

import { BROWSER_UA, getJson } from "./http.js";
import { buildObservation, toCents } from "./observation.js";

const DEFAULT_LIMIT = 250;

/** Pure: extract the products array from a products.json payload. */
export function parseShopifyProducts(json) {
  return Array.isArray(json?.products) ? json.products : [];
}

function digitsOnly(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 6 && digits.length <= 14 ? digits : undefined;
}

/** Pure: one observation per variant of a Shopify product. */
export function toShopifyObservations(product, store, options = {}) {
  const variants = Array.isArray(product?.variants) ? product.variants : [];
  if (!product?.id || !product?.handle || variants.length === 0) return [];
  const url = `${store.origin}/products/${product.handle}`;
  const image = product.images?.[0]?.src ?? undefined;
  const categories = [
    ...(product.product_type ? [product.product_type] : []),
    ...(Array.isArray(product.tags) ? product.tags.slice(0, 3) : []),
  ];

  return variants
    .map((variant) => {
      // The live price is authoritative. compare_at is only a was-price
      // when it parses AND sits above the live price — inverted or junk
      // values are ignored instead of mispricing regular or killing the
      // variant.
      const priceCents = toCents(variant.price);
      if (priceCents === undefined || priceCents <= 0) return undefined;
      const wasCents = variant.compare_at_price != null ? toCents(variant.compare_at_price) : undefined;
      const onSale = wasCents !== undefined && wasCents > priceCents;
      const base = onSale ? wasCents : priceCents;
      return buildObservation({
        slug: store.retailer,
        storeId: store.scopeId,
        storeName: store.name,
        origin: store.origin,
        region: store.region,
        retailerProductId: String(variant.id ?? product.id),
        url,
        name: product.title,
        brand: product.vendor,
        gtin: digitsOnly(variant.barcode),
        categories,
        image,
        regularCents: base,
        ...(onSale ? { promoCents: priceCents } : {}),
        observedAt: options.observedAt,
      });
    })
    .filter(Boolean);
}

export class ShopifyCatalogClient {
  constructor(options = {}) {
    if (!options.origin) throw new TypeError("ShopifyCatalogClient requires origin");
    this.origin = options.origin.replace(/\/$/, "");
    this.slug = options.slug;
    if (!this.slug) throw new TypeError("ShopifyCatalogClient requires slug");
    this.scopeId = options.scopeId ?? "online";
    this.scopeName = options.scopeName ?? options.slug;
    this.region = options.region;
    this.headers = { "user-agent": options.userAgent ?? BROWSER_UA, ...options.headers };
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = options.timeout ?? 15000;
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
      ...(this.region ? { region: this.region } : {}),
      origin: this.origin,
    };
  }

  async #productsJson(path, page, limit) {
    const url = new URL(path, this.origin);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("page", String(page));
    return getJson(url, {
      fetch: this.#fetch,
      headers: this.headers,
      timeout: this.#timeout,
      retry: this.#retry,
      operation: `shopify ${path} page ${page}`,
    });
  }

  /** One page of the full published catalog. */
  async listProducts({ page = 1, pageSize = DEFAULT_LIMIT } = {}) {
    return parseShopifyProducts(await this.#productsJson("/products.json", page, pageSize));
  }

  /** One page of a single collection by handle. */
  async listCategory(handle, { page = 1, pageSize = DEFAULT_LIMIT } = {}) {
    return parseShopifyProducts(
      await this.#productsJson(`/collections/${encodeURIComponent(handle)}/products.json`, page, pageSize),
    );
  }

  async listCollections({ page = 1, limit = DEFAULT_LIMIT } = {}) {
    const url = new URL("/collections.json", this.origin);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("page", String(page));
    return getJson(url, {
      fetch: this.#fetch,
      headers: this.headers,
      timeout: this.#timeout,
      retry: this.#retry,
      operation: "shopify /collections.json",
    }).then((json) => (Array.isArray(json?.collections) ? json.collections : []));
  }

  /**
   * Walk the full catalog into validated PriceObservations. Stops at the
   * first short page; dedupes by product id.
   */
  async collectProducts({ maxPages = Number.POSITIVE_INFINITY, pageSize = DEFAULT_LIMIT, observedAt } = {}) {
    const store = this.getStore();
    const seen = new Map();
    for (let page = 1; page <= maxPages; page += 1) {
      const products = await this.listProducts({ page, pageSize });
      for (const product of products) {
        if (!seen.has(product.id)) seen.set(product.id, product);
      }
      if (products.length < pageSize || page >= maxPages) break;
    }
    return [...seen.values()].flatMap((product) =>
      toShopifyObservations(product, store, { observedAt }),
    );
  }
}
