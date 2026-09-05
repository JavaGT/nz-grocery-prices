/**
 * Devonport Chocolates — NZ chocolate maker (Devonport, Auckland).
 *
 * Platform: Shopify public storefront JSON. Verified live 2026-09-06
 * (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "devonport-chocolates",
  name: "Devonport Chocolates",
  origin: "https://devonportchocolates.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Devonport Chocolates Online",
    ...options,
  });
}
