/**
 * Southern Salon Supplies — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "southern-salon-supplies",
  name: "Southern Salon Supplies",
  origin: "https://southernsalonsupplies.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Southern Salon Supplies Online",
    ...options,
  });
}
