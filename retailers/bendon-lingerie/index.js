/**
 * Bendon Lingerie — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live 2026-09-06
 * (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "bendon-lingerie",
  name: "Bendon Lingerie",
  origin: "https://bendonlingerie.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Bendon Lingerie Online",
    ...options,
  });
}
