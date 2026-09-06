/**
 * YOUKNOW Clothing — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "youknow-clothing",
  name: "YOUKNOW Clothing",
  origin: "https://nz.youknowclothing.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "YOUKNOW Clothing Online",
    ...options,
  });
}
