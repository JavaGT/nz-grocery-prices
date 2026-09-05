/**
 * Ultimate Surf & Skate — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live 2026-09-06
 * (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "ultimate-surf-skate",
  name: "Ultimate Surf & Skate",
  origin: "https://ultimatesurfnskate.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Ultimate Surf & Skate Online",
    ...options,
  });
}
