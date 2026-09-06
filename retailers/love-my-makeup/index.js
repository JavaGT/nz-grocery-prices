/**
 * LoveMy Makeup — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "love-my-makeup",
  name: "LoveMy Makeup",
  origin: "https://lovemymakeup.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "LoveMy Makeup Online",
    ...options,
  });
}
