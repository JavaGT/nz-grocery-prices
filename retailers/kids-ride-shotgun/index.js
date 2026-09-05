/**
 * Kids Ride Shotgun — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live 2026-09-06
 * (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "kids-ride-shotgun",
  name: "Kids Ride Shotgun",
  origin: "https://www.kidsrideshotgun.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Kids Ride Shotgun Online",
    ...options,
  });
}
