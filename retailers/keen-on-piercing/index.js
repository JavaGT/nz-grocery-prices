/**
 * Keen on Piercing — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "keen-on-piercing",
  name: "Keen on Piercing",
  origin: "https://keenonpiercing.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Keen on Piercing Online",
    ...options,
  });
}
