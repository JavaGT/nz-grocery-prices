/**
 * Dancing Sands Distillery — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "dancing-sands",
  name: "Dancing Sands Distillery",
  origin: "https://dancingsands.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Dancing Sands Distillery Online",
    ...options,
  });
}
