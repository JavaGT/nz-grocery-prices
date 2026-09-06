/**
 * Rabbit Island Coffee Co — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "rabbit-island-coffee",
  name: "Rabbit Island Coffee Co",
  origin: "https://rabbitislandcoffee.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Rabbit Island Coffee Co Online",
    ...options,
  });
}
