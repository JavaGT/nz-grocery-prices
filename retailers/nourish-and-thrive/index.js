/**
 * Nourish and Thrive — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "nourish-and-thrive",
  name: "Nourish and Thrive",
  origin: "https://nourishandthrive.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Nourish and Thrive Online",
    ...options,
  });
}
