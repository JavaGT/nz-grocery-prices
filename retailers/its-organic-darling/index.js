/**
 * Its Organic Darling — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "its-organic-darling",
  name: "Its Organic Darling",
  origin: "https://itsorganicdarling.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Its Organic Darling Online",
    ...options,
  });
}
