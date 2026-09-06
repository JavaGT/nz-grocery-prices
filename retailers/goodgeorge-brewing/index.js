/**
 * Good George Brewing — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "goodgeorge-brewing",
  name: "Good George Brewing",
  origin: "https://goodgeorge.kiwi.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Good George Brewing Online",
    ...options,
  });
}
