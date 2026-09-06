/**
 * The NZ Natural Pet Food Co — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "nz-natural-pet-food",
  name: "The NZ Natural Pet Food Co",
  origin: "https://nznaturalpetfood.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "The NZ Natural Pet Food Co Online",
    ...options,
  });
}
