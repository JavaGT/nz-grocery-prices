/**
 * Lyttelton Lights — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "lyttelton-lights",
  name: "Lyttelton Lights",
  origin: "https://lytteltonlights.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Lyttelton Lights Online",
    ...options,
  });
}
