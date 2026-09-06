/**
 * Mons Royale NZ — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "mons-royale-nz",
  name: "Mons Royale NZ",
  origin: "https://nz.monsroyale.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Mons Royale NZ Online",
    ...options,
  });
}
