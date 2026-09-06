/**
 * Cardrona Distillery — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "cardrona-distillery",
  name: "Cardrona Distillery",
  origin: "https://cardronadistillery.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Cardrona Distillery Online",
    ...options,
  });
}
