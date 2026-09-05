/**
 * Commonsense Organics — NZ organic grocery chain.
 *
 * Platform: SilverStripe shop behind Cloudflare. Category pages double as
 * JSON-LD Product pages (each /shop-online/ leaf is a single product with
 * offers.price NZD), and the SilverStripe sitemap enumerates them all.
 * One request per product; budget with --page-size × --max-pages.
 * Verified live 2026-09-06 (see README.md).
 */

import { JsonLdPdpClient, parseJsonLdProducts, jsonLdProductSpec } from "../_lib/jsonld-pdp.js";

export const RETAILER = {
  slug: "commonsense-organics",
  name: "Commonsense Organics",
  origin: "https://commonsenseorganics.co.nz",
  platform: "jsonld-pdp",
};

export const SITEMAPS = [
  "https://commonsenseorganics.co.nz/sitemap.xml/sitemap/SilverStripe-CMS-Model-SiteTree/1",
  "https://commonsenseorganics.co.nz/sitemap.xml/sitemap/SilverStripe-CMS-Model-SiteTree/2",
];

export const URL_FILTER = /\/shop-online\/.+\/$/;

/** Parse the category/product page into a buildObservation spec. */
export function mapHtml(html, url) {
  const [product] = parseJsonLdProducts(html);
  const spec = product ? jsonLdProductSpec(product) : undefined;
  if (!spec) return undefined;
  const sku = product?.sku ?? url.match(/\/([a-z0-9-]+)\/$/)?.[1];
  return { ...spec, retailerProductId: String(sku), url };
}

export function createClient(options = {}) {
  return new JsonLdPdpClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Commonsense Organics Online",
    sitemaps: SITEMAPS,
    urlFilter: URL_FILTER,
    mapHtml,
    ...options,
  });
}
