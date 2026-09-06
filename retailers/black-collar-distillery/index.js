/**
 * Black Collar Distillery — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "black-collar-distillery",
  name: "Black Collar Distillery",
  origin: "https://blackcollardistillery.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Black Collar Distillery Online",
    ...options,
  });
}
