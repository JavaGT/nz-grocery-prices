/**
 * Snuggle Hunny NZ — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live 2026-09-06
 * (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "snuggle-hunny",
  name: "Snuggle Hunny NZ",
  origin: "https://snugglehunnykids.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Snuggle Hunny NZ Online",
    ...options,
  });
}
