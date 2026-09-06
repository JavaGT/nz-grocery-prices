/**
 * Saint Clair Family Estate — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "saint-clair",
  name: "Saint Clair Family Estate",
  origin: "https://saintclair.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Saint Clair Family Estate Online",
    ...options,
  });
}
