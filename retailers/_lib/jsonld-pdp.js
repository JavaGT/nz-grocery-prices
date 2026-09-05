/**
 * Sitemap → product-detail-page (JSON-LD) adapter for the retailers/
 * campaign.
 *
 * The universal fallback for custom storefronts without listing APIs:
 * product URLs come from sitemaps, and each server-rendered PDP carries a
 * schema.org JSON-LD Product (name, brand, gtin13, offers.price). Sites
 * with HTML microdata instead of JSON-LD can pass a `mapHtml(html, url)`
 * override that returns the same spec shape.
 */

import { getText } from "./http.js";
import { buildObservation, toCents } from "./observation.js";

/** Extract JSON-LD blocks (tolerant) and return the @type Product nodes. */
export function parseJsonLdProducts(html) {
  const products = [];
  const blocks = [...html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  )];
  for (const block of blocks) {
    let parsed;
    try {
      parsed = JSON.parse(block[1].trim());
    } catch {
      continue;
    }
    const graph = parsed?.["@graph"];
    const graphNodes = Array.isArray(graph) ? graph : graph ? [graph] : [];
    const nodes = Array.isArray(parsed) ? parsed : [parsed, ...graphNodes];
    for (const node of nodes) {
      const type = node?.["@type"];
      const types = Array.isArray(type) ? type : [type];
      if (types.includes("Product")) products.push(node);
    }
  }
  return products;
}

/** Map one JSON-LD Product node to a buildObservation spec (minus store). */
export function jsonLdProductSpec(product) {
  // offers can be a single Offer, an array of Offers (take the cheapest
  // in-stock-ish one), or an AggregateOffer with lowPrice. Each offer may
  // carry price directly or inside priceSpecification (also possibly an
  // array). Raw values go straight to toCents so "$5.14" strings parse.
  const offers = Array.isArray(product?.offers)
    ? product.offers
    : product?.offers
      ? [product.offers]
      : [];
  const offerPrices = offers.map((offer) => {
    if (offer?.["@type"] === "AggregateOffer" && offer?.lowPrice != null) {
      return toCents(offer.lowPrice);
    }
    const spec = Array.isArray(offer?.priceSpecification)
      ? offer.priceSpecification[0]
      : offer?.priceSpecification;
    return toCents(offer?.price ?? spec?.price);
  }).filter((cents) => cents !== undefined && cents > 0);
  const highPrices = offers.map((offer) => toCents(offer?.highPrice)).filter((cents) => cents !== undefined && cents > 0);
  const price = offerPrices.length ? Math.min(...offerPrices) : undefined;
  const was = highPrices.length ? Math.max(...highPrices) : undefined;
  const name = typeof product?.name === "string" ? product.name.trim() : undefined;
  if (!name || price === undefined || price <= 0) return undefined;
  const brandName =
    (typeof product?.brand === "object" ? product.brand?.name : product?.brand) ??
    (typeof product?.manufacturer === "object" ? product.manufacturer?.name : product?.manufacturer);
  const gtinRaw = product?.gtin13 ?? product?.gtin ?? product?.gtin12 ?? product?.sku;
  const gtin = String(gtinRaw ?? "").replace(/\D/g, "");
  const image = Array.isArray(product?.image) ? product.image[0] : product?.image;
  return {
    name,
    brand: typeof brandName === "string" && brandName ? brandName : undefined,
    gtin: gtin.length >= 8 && gtin.length <= 14 ? gtin : undefined,
    image: typeof image === "string" ? image : undefined,
    regularCents: was !== undefined && was > price ? was : price,
    ...(was !== undefined && was > price ? { promoCents: price } : {}),
  };
}

export class JsonLdPdpClient {
  constructor(options = {}) {
    if (!options.slug || !options.origin) {
      throw new TypeError("JsonLdPdpClient requires slug and origin");
    }
    if (typeof options.mapHtml !== "function") {
      throw new TypeError("JsonLdPdpClient requires mapHtml(html, url) -> spec");
    }
    if (!Array.isArray(options.sitemaps) || options.sitemaps.length === 0) {
      throw new TypeError("JsonLdPdpClient requires sitemaps: [url, ...]");
    }
    this.origin = options.origin.replace(/\/$/, "");
    this.slug = options.slug;
    this.scopeId = options.scopeId ?? "online";
    this.scopeName = options.scopeName ?? options.slug;
    this.sitemaps = options.sitemaps;
    this.urlFilter = options.urlFilter ?? /\//;
    this.mapHtml = options.mapHtml;
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

  async #text(url, operation) {
    return getText(url, {
      fetch: this.#fetch,
      headers: this.headers,
      timeout: this.#timeout,
      retry: this.#retry,
      operation: operation ?? url,
    });
  }

  /** Resolve a sitemap entry (index or flat) into product URLs. */
  async listProductUrls({ maxShards = 10 } = {}) {
    const urls = [];
    for (const sitemap of this.sitemaps) {
      const xml = await this.#text(sitemap, "sitemap fetch");
      if (xml.includes("<sitemapindex")) {
        const children = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).slice(0, maxShards);
        for (const child of children) {
          const childXml = await this.#text(child, "sitemap shard fetch");
          urls.push(...[...childXml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
        }
      } else {
        urls.push(...[...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]));
      }
    }
    return [...new Set(urls.filter((url) => this.urlFilter.test(url)))];
  }

  /**
   * Walk sitemap product URLs and map each PDP through `mapHtml`.
   * Speaking the shared runner contract, the real cost (one request per
   * product) is bounded to maxPages × pageSize products per run.
   */
  async collectProducts({ maxPages = 10, pageSize = 10, observedAt } = {}) {
    const store = this.getStore();
    const maxProducts = maxPages * pageSize;
    const urls = await this.listProductUrls();
    const observations = [];
    let fetched = 0;
    for (const url of urls) {
      if (fetched >= maxProducts) break;
      let html;
      try {
        html = await this.#text(url, `pdp ${this.slug}`);
      } catch (error) {
        console.error(`jsonld ${this.slug}: skipping ${url}: ${error.message}`);
        continue;
      }
      const spec = this.mapHtml(html, url);
      if (!spec) continue;
      const observation = buildObservation({
        slug: this.slug,
        storeId: this.scopeId,
        storeName: this.scopeName,
        origin: this.origin,
        observedAt,
        ...spec,
      });
      if (observation) {
        observations.push(observation);
        fetched += 1;
      }
    }
    return observations;
  }
}
