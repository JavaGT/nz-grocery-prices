/**
 * Moore Wilson's — Wellington wholesale grocer.
 *
 * Platform: headless Shopify Hydrogen — classic products.json endpoints are
 * disabled, but the SSR product pages render prices in HTML and the
 * sitemap (sitemap/products/N.xml) enumerates every product.
 * One request per product; budget with --page-size × --max-pages.
 * Verified live 2026-09-06 (see README.md).
 */

import { JsonLdPdpClient } from "../_lib/jsonld-pdp.js";
import { buildObservation, toCents } from "../_lib/observation.js";

export const RETAILER = {
  slug: "moore-wilsons",
  name: "Moore Wilson's",
  origin: "https://www.moorewilsons.co.nz",
  platform: "hydrogen-pdp",
};

export const SITEMAPS = ["https://www.moorewilsons.co.nz/sitemap/products/1.xml"];

/** Parse the SSR product page into a buildObservation spec. */
export function mapHtml(html, url) {
  const name = html.match(/<title[^>]*>([^<]+)<\/title>/)?.[1]
    ?.replace(/^Moore Wilsons\s*\|\s*/, "")
    .trim();
  const price = html.match(/class="product-price[^"]*"[^>]*>\s*<div>NZ\$([\d,.]+)/)?.[1];
  const regularCents = toCents(price);
  if (!name || regularCents === undefined) return undefined;
  const code = url.match(/\/products\/(\d+)-/)?.[1];
  if (!code) return undefined;
  return {
    slug: RETAILER.slug,
    storeId: "online",
    storeName: "Moore Wilson's Online",
    origin: RETAILER.origin,
    retailerProductId: code,
    url,
    name,
    regularCents,
  };
}

export function createClient(options = {}) {
  return new JsonLdPdpClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Moore Wilson's Online",
    sitemaps: SITEMAPS,
    urlFilter: /\/products\/\d+-/,
    mapHtml,
    ...options,
  });
}
