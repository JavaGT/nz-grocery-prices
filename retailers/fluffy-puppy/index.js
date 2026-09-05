/**
 * Fluffy Puppy — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live 2026-09-06
 * (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "fluffy-puppy",
  name: "Fluffy Puppy",
  origin: "https://fluffypuppypetstore.com/en-nz/",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Fluffy Puppy Online",
    ...options,
  });
}
