/**
 * INIKA Organic NZ — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "inika-organic-nz",
  name: "INIKA Organic NZ",
  origin: "https://nz.inikaorganic.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "INIKA Organic NZ Online",
    ...options,
  });
}
