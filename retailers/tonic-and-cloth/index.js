/**
 * Tonic & Cloth — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "tonic-and-cloth",
  name: "Tonic & Cloth",
  origin: "https://tonicandcloth.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Tonic & Cloth Online",
    ...options,
  });
}
