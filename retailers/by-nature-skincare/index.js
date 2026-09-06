/**
 * By Nature Skincare — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "by-nature-skincare",
  name: "By Nature Skincare",
  origin: "https://bynatureskincare.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "By Nature Skincare Online",
    ...options,
  });
}
