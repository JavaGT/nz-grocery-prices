/**
 * Tea Store Aotearoa — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "tea-store-aotearoa",
  name: "Tea Store Aotearoa",
  origin: "https://teastore.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Tea Store Aotearoa Online",
    ...options,
  });
}
