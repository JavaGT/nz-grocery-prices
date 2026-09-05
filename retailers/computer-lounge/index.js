/**
 * Computer Lounge — NZ retailer online store.
 *
 * Platform: Shopify. Catalog via GET /products.json (published products,
 * 250/page). Verified live 2026-09-06 (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "computer-lounge",
  name: "Computer Lounge",
  origin: "https://www.computerlounge.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Computer Lounge Online",
    ...options,
  });
}
