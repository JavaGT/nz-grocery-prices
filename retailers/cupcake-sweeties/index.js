/**
 * Cupcake Sweeties — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live 2026-09-06
 * (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "cupcake-sweeties",
  name: "Cupcake Sweeties",
  origin: "https://cupcakesweeties.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Cupcake Sweeties Online",
    ...options,
  });
}
