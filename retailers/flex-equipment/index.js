/**
 * Flex Fitness Equipment — NZ fitness equipment retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "flex-equipment",
  name: "Flex Fitness Equipment",
  origin: "https://flexequipment.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Flex Fitness Equipment Online",
    ...options,
  });
}
