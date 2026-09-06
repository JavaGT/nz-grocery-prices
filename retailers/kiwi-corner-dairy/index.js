/**
 * Kiwi Corner Dairy — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "kiwi-corner-dairy",
  name: "Kiwi Corner Dairy",
  origin: "https://kiwicornerdairy.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Kiwi Corner Dairy Online",
    ...options,
  });
}
