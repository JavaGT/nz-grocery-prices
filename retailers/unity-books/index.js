/**
 * Unity Books — NZ's leading independent bookshop (Wellington + Auckland).
 *
 * Platform: Shopify Hydrogen headless (Oxygen). Product pages are
 * server-rendered but embed the price with a React comment break
 * (`$<!-- -->38.00`), and there is no product sitemap — product URLs are
 * discovered from the homepage/collection page links and fetched
 * one-by-one. Verified live 2026-09-06 (see README.md).
 */

import { getText } from "../_lib/http.js";
import { buildObservation, toCents } from "../_lib/observation.js";

export const RETAILER = {
  slug: "unity-books",
  name: "Unity Books",
  origin: "https://www.unitybooks.co.nz",
  platform: "hydrogen-pdp",
};

export const HOME_URL = "https://www.unitybooks.co.nz/";

/** Pure: extract /products/<handle> links from a Unity page. */
export function parseProductLinks(html) {
  return [...new Set(
    [...html.matchAll(/href="(\/products\/[a-z0-9-]+)"/g)].map((m) => m[1]),
  )];
}

/** Pure: map a PDP HTML to a buildObservation spec. */
export function mapPdpHtml(html, productPath) {
  // React renders the price as `$<!-- -->38.00` — strip comments first.
  const flat = html.replace(/<!--[\s\S]*?-->/g, "");
  const priceMatch = flat.match(
    /class="[^"]*font-bold[^"]*"[^>]*>\s*\$<!-- -->?([\d,.]+)/,
  ) ?? flat.match(/\$<!-- -->([\d,.]+)/) ?? flat.match(/\$([\d,.]+)/);
  const regularCents = priceMatch ? toCents(priceMatch[1]) : undefined;
  const rawTitle = flat.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] ?? "";
  // strip the trailing " - Unity Books" site suffix
  const name = rawTitle.replace(/\s*[-|\u2013]\s*Unity Books.*$/i, "").trim();
  if (!name || regularCents === undefined || regularCents <= 0) return undefined;
  const handle = productPath.replace(/^\//, "");
  return {
    slug: RETAILER.slug,
    storeId: "online",
    storeName: "Unity Books Online",
    origin: RETAILER.origin,
    retailerProductId: handle,
    url: `${RETAILER.origin}${productPath}`,
    name,
    regularCents,
  };
}

export class UnityBooksClient {
  constructor(options = {}) {
    this.userAgent = options.userAgent;
    this.headers = { "user-agent": options.userAgent ?? undefined, ...options.headers };
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = options.timeout ?? 25000;
  }
  #fetch;
  #timeout;

  getStore() {
    return {
      id: `${RETAILER.slug}:online`,
      retailer: RETAILER.slug,
      name: "Unity Books Online",
      origin: RETAILER.origin,
    };
  }

  /** Collect /products/<handle> links from the homepage. */
  async listProductLinks() {
    const html = await getText(HOME_URL, {
      fetch: this.#fetch,
      headers: this.headers,
      timeout: this.#timeout,
      operation: "unity-books home",
    });
    return parseProductLinks(html);
  }

  /** Fetch one PDP and map it to a validated spec. */
  async fetchProduct(productPath) {
    const html = await getText(`${RETAILER.origin}${productPath}`, {
      fetch: this.#fetch,
      headers: this.headers,
      timeout: this.#timeout,
      operation: `unity-books ${productPath}`,
    });
    return mapPdpHtml(html, productPath);
  }

  /**
   * Crawl the homepage product links, then fetch each PDP. Speaking the
   * shared runner contract: --page-size bounds the number of PDP fetches
   * (one request per book — the real cost).
   */
  async collectProducts({ pageSize = 20, observedAt } = {}) {
    const links = (await this.listProductLinks()).slice(0, pageSize);
    const observations = [];
    for (const link of links) {
      try {
        const html = await getText(`${RETAILER.origin}${link}`, {
          fetch: this.#fetch,
          headers: this.headers,
          timeout: this.#timeout,
          operation: `unity-books ${link}`,
        });
        const spec = mapPdpHtml(html, link);
        const observation = spec
          ? buildObservation({ ...spec, observedAt })
          : undefined;
        if (observation) observations.push(observation);
      } catch (error) {
        console.error(`unity-books: skipping ${link}: ${error.message}`);
      }
    }
    return observations;
  }
}

export function createClient(options = {}) {
  return new UnityBooksClient(options);
}
