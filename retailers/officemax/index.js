/**
 * OfficeMax NZ — office products and stationery supplier.
 *
 * Platform: Commerce Vision. Category grids are client-rendered (Kendo +
 * WebServicesAjax — no SSR prices), but the sitemap enumerates every PDP
 * and PDPs are server-rendered with schema.org JSON-LD Product data.
 * One request per product; budget with --page-size.
 * Verified live 2026-09-06 (see README.md).
 */

import { JsonLdPdpClient, parseJsonLdProducts, jsonLdProductSpec } from "../_lib/jsonld-pdp.js";
import { buildObservation } from "../_lib/observation.js";

export const RETAILER = {
  slug: "officemax",
  name: "OfficeMax NZ",
  origin: "https://www.officemax.co.nz",
  platform: "jsonld-pdp",
};

export const SITEMAPS = ["https://www.officemax.co.nz/Sitemap_Products.xml"];

/** PDP URLs end in a 5+ digit product code. */
export const URL_FILTER = /-\d{5,}$/;

/** Parse the PDP HTML into a buildObservation spec. */
export function mapHtml(html, url) {
  const [product] = parseJsonLdProducts(html);
  const spec = product ? jsonLdProductSpec(product) : undefined;
  if (!spec) return undefined;
  const code = html.match(/data-product-code="([^"]+)"/)?.[1]
    ?? url.match(/-(\d{5,})$/)?.[1]
    ?? String(product?.sku ?? "");
  return { ...spec, retailerProductId: code, url };
}

export function createClient(options = {}) {
  return new JsonLdPdpClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "OfficeMax NZ Online",
    sitemaps: SITEMAPS,
    urlFilter: URL_FILTER,
    mapHtml,
    ...options,
  });
}
