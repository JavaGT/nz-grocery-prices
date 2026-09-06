/**
 * Kiwi Spirit Distillery — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "kiwi-spirit-distillery",
  name: "Kiwi Spirit Distillery",
  origin: "https://kiwispiritdistillery.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Kiwi Spirit Distillery Online",
    ...options,
  });
}
