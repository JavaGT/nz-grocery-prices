/**
 * Watches of New Zealand — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "watches-of-nz",
  name: "Watches of New Zealand",
  origin: "https://watchesofnz.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Watches of New Zealand Online",
    ...options,
  });
}
