/**
 * Hogarth Chocolate — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "hogarth-chocolate",
  name: "Hogarth Chocolate",
  origin: "https://hogarthchocolate.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Hogarth Chocolate Online",
    ...options,
  });
}
