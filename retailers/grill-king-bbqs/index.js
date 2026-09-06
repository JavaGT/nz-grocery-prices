/**
 * Grill King BBQs — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "grill-king-bbqs",
  name: "Grill King BBQs",
  origin: "https://grillkingbbqs.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Grill King BBQs Online",
    ...options,
  });
}
