/**
 * Eco Tan New Zealand — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "eco-tan-nz",
  name: "Eco Tan New Zealand",
  origin: "https://ecotan.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Eco Tan New Zealand Online",
    ...options,
  });
}
