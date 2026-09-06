/**
 * Mcinnes and Co — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "mcinnes-and-co",
  name: "Mcinnes and Co",
  origin: "https://mcinnesandco.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Mcinnes and Co Online",
    ...options,
  });
}
