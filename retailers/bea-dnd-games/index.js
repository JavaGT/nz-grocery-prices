/**
 * Bea DnD Games — NZ board game / hobby store.
 *
 * Platform: Shopify public storefront JSON. Verified live 2026-09-06
 * (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "bea-dnd-games",
  name: "Bea DnD Games",
  origin: "https://beadndgames.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Bea DnD Games Online",
    ...options,
  });
}
