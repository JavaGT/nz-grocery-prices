/**
 * Nevalea Alpacas — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "nevalea-alpacas",
  name: "Nevalea Alpacas",
  origin: "https://nevaleaalpacas.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Nevalea Alpacas Online",
    ...options,
  });
}
