/**
 * Sans Ceuticals — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "sans-ceuticals",
  name: "Sans Ceuticals",
  origin: "https://sansceuticals.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Sans Ceuticals Online",
    ...options,
  });
}
