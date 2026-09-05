/**
 * Mitre 10 — NZ hardware and DIY chain.
 *
 * Platform: SAP Commerce (Angular storefront, SSR with embedded JSON).
 * The OCC REST API at ccapi.mitre10.co.nz is open for product details
 * (GET /occ/v2/mitre10/products/<code>?fields=FULL); free-text product
 * search is disabled through the API (0 results), so the catalog is
 * discovered via the 83 product sitemap shards (Product-en-NZD-0..82) and
 * collected one product detail at a time.
 * Verified live 2026-09-06 (see README.md).
 */

import { getJson, getText } from "../_lib/http.js";
import { buildObservation, toCents } from "../_lib/observation.js";

export const RETAILER = {
  slug: "mitre-10",
  name: "Mitre 10",
  origin: "https://www.mitre10.co.nz",
  platform: "sap-occ",
};

const OCC_ORIGIN = "https://ccapi.mitre10.co.nz";
const BASE_SITE = "mitre10";
const SITEMAP_INDEX = `${RETAILER.origin}/sitemap.xml`;

export const SHARD_COUNT = 83;

/** List the product-sitemap shard URLs from the sitemap index. */
export async function listShardUrls(options = {}) {
  const xml = await getText(SITEMAP_INDEX, {
    fetch: options.fetch,
    headers: { "user-agent": options.userAgent },
    timeout: options.timeout,
    retry: options.retry,
    operation: "mitre-10 sitemap index",
  });
  return [...xml.matchAll(/<loc>([^<]*Product-en-NZD-\d+[^<]*)<\/loc>/g)].map((m) => m[1]);
}

/** Extract product URLs (…/p/<code>) from one sitemap shard. */
export function parseShardProductUrls(xml) {
  return [...xml.matchAll(/<loc>([^<]*\/p\/[^<]+)<\/loc>/g)].map((m) => m[1]);
}

function priceCents(price) {
  if (!price) return undefined;
  const cents = toCents(Number(price.value));
  return cents === undefined ? undefined : cents;
}

/** Pure: map an OCC product detail payload to an observation spec. */
export function mapDetail(detail) {
  const currentCents = priceCents(detail?.price);
  if (!detail?.code || !detail?.name || currentCents === undefined) return undefined;
  const regular = priceCents(detail?.regularPrice);
  const hasDiscount = regular !== undefined && regular > currentCents;
  const image = detail?.images?.[0]?.url
    ? `${OCC_ORIGIN}${detail.images[0].url}`
    : undefined;
  return {
    slug: RETAILER.slug,
    storeId: "online",
    storeName: "Mitre 10 Online",
    origin: RETAILER.origin,
    retailerProductId: String(detail.code),
    url: `${RETAILER.origin}${detail.canonicalUrl ?? detail.url ?? `/p/${detail.code}`}`,
    name: detail.name,
    brand: detail.brandName ?? undefined,
    image,
    regularCents: hasDiscount ? regular : currentCents,
    ...(hasDiscount ? { promoCents: currentCents } : {}),
  };
}

export async function fetchProductDetail(code, options = {}) {
  const url = `${OCC_ORIGIN}/occ/v2/${BASE_SITE}/products/${encodeURIComponent(code)}?fields=FULL`;
  return getJson(url, {
    fetch: options.fetch,
    headers: { "user-agent": options.userAgent },
    timeout: options.timeout,
    retry: options.retry,
    operation: `mitre-10 occ ${code}`,
  });
}

export class Mitre10Client {
  constructor(options = {}) {
    this.userAgent = options.userAgent;
    this.headers = options.headers;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = options.timeout ?? 25000;
    this.#retry = options.retry;
  }
  #fetch;
  #timeout;
  #retry;

  getStore() {
    return {
      id: `${RETAILER.slug}:online`,
      retailer: RETAILER.slug,
      name: "Mitre 10 Online",
      origin: RETAILER.origin,
    };
  }

  /**
   * Collect by walking sitemap shards and fetching each product's OCC
   * detail. Speaking the shared runner contract: `maxPages` bounds the
   * number of sitemap shards per run and `pageSize` bounds the total
   * product detail requests (the real cost — one request per product).
   */
  async collectProducts({ maxPages = 1, pageSize = 200, observedAt } = {}) {
    const shards = (await listShardUrls({ fetch: this.#fetch, timeout: this.#timeout })).slice(0, maxPages);
    const observations = [];
    let fetched = 0;
    for (const shard of shards) {
      if (fetched >= pageSize) break;
      const xml = await getText(shard, {
        fetch: this.#fetch,
        headers: { "user-agent": this.userAgent },
        timeout: this.#timeout,
        retry: this.#retry,
        operation: "mitre-10 sitemap shard",
      });
      for (const productUrl of parseShardProductUrls(xml)) {
        if (fetched >= pageSize) break;
        const code = productUrl.match(/\/p\/(\d+)$/)?.[1];
        if (!code) continue;
        const detail = await fetchProductDetail(code, {
          fetch: this.#fetch,
          timeout: this.#timeout,
          retry: this.#retry,
        });
        const spec = mapDetail(detail);
        const observation = spec
          ? buildObservation({ ...spec, observedAt })
          : undefined;
        if (observation) {
          observations.push(observation);
          fetched += 1;
        }
      }
    }
    return observations;
  }
}

export function createClient(options = {}) {
  return new Mitre10Client(options);
}
