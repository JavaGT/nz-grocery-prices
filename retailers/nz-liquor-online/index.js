/**
 * NZ Liquor Online — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live 2026-09-06
 * (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "nz-liquor-online",
  name: "NZ Liquor Online",
  origin: "https://nzliquor.online",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "NZ Liquor Online Online",
    ...options,
  });
}
