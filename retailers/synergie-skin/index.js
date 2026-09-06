/**
 * Synergie Skin NZ — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "synergie-skin",
  name: "Synergie Skin NZ",
  origin: "https://synergieskin.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Synergie Skin NZ Online",
    ...options,
  });
}
