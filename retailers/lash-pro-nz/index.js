/**
 * Lash Pro NZ — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "lash-pro-nz",
  name: "Lash Pro NZ",
  origin: "https://lashpro.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Lash Pro NZ Online",
    ...options,
  });
}
