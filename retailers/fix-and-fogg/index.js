/**
 * Fix & Fogg — NZ nut butter producer (direct web store).
 *
 * Platform: Shopify public storefront JSON. Verified live 2026-09-06
 * (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "fix-and-fogg",
  name: "Fix & Fogg",
  origin: "https://fixandfogg.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Fix & Fogg Online",
    ...options,
  });
}
