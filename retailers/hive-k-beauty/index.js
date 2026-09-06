/**
 * Hive K-Beauty by Reina — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "hive-k-beauty",
  name: "Hive K-Beauty by Reina",
  origin: "https://k-beauty.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Hive K-Beauty by Reina Online",
    ...options,
  });
}
