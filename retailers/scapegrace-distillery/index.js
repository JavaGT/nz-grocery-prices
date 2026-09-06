/**
 * Scapegrace Distillery — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "scapegrace-distillery",
  name: "Scapegrace Distillery",
  origin: "https://scapegracedistillery.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Scapegrace Distillery Online",
    ...options,
  });
}
