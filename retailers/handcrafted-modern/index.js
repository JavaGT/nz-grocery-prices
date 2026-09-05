/**
 * Handcrafted Modern — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live 2026-09-06
 * (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "handcrafted-modern",
  name: "Handcrafted Modern",
  origin: "https://handcraftedmodern.co",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Handcrafted Modern Online",
    ...options,
  });
}
