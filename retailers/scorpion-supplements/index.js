/**
 * Scorpion Supplements — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live 2026-09-06
 * (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "scorpion-supplements",
  name: "Scorpion Supplements",
  origin: "https://scorpionsupplements.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Scorpion Supplements Online",
    ...options,
  });
}
