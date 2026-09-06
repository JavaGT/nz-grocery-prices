/**
 * Velvet Heartbeat — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "velvet-heartbeat",
  name: "Velvet Heartbeat",
  origin: "https://velvetheartbeat.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Velvet Heartbeat Online",
    ...options,
  });
}
