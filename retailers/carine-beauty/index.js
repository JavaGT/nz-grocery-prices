/**
 * Carine Beauty Therapy — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "carine-beauty",
  name: "Carine Beauty Therapy",
  origin: "https://carinebeautytherapy.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Carine Beauty Therapy Online",
    ...options,
  });
}
