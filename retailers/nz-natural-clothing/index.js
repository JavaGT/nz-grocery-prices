/**
 * NZ Natural Clothing — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "nz-natural-clothing",
  name: "NZ Natural Clothing",
  origin: "https://nznaturalclothesshop.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "NZ Natural Clothing Online",
    ...options,
  });
}
