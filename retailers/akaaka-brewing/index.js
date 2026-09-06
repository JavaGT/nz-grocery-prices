/**
 * Aka Aka Brewing — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "akaaka-brewing",
  name: "Aka Aka Brewing",
  origin: "https://akaakabrewing.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Aka Aka Brewing Online",
    ...options,
  });
}
