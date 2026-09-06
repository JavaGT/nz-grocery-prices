/**
 * Surmanti Nail Tech Training — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "nailtechtraining",
  name: "Surmanti Nail Tech Training",
  origin: "https://nailtechtraining.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Surmanti Nail Tech Training Online",
    ...options,
  });
}
