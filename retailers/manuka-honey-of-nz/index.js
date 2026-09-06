/**
 * Manuka Honey of NZ — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "manuka-honey-of-nz",
  name: "Manuka Honey of NZ",
  origin: "https://manukahoneyofnz.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Manuka Honey of NZ Online",
    ...options,
  });
}
