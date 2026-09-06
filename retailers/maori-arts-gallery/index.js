/**
 * Maori Arts Gallery — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "maori-arts-gallery",
  name: "Maori Arts Gallery",
  origin: "https://maoriartsgallery.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Maori Arts Gallery Online",
    ...options,
  });
}
