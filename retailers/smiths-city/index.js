/**
 * Smiths City — NZ retailer online store.
 *
 * Platform: Shopify. Catalog via GET /products.json (published products,
 * 250/page). Verified live 2026-09-06 (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "smiths-city",
  name: "Smiths City",
  origin: "https://www.smithscity.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Smiths City Online",
    ...options,
  });
}
