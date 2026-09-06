/**
 * Mochi Mochi NZ — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "mochi-mochi",
  name: "Mochi Mochi NZ",
  origin: "https://mochimochi.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Mochi Mochi NZ Online",
    ...options,
  });
}
