/**
 * Kidzstuffonline — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "kidzstuffonline",
  name: "Kidzstuffonline",
  origin: "https://kidzstuffonline.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Kidzstuffonline Online",
    ...options,
  });
}
