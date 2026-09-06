/**
 * Notting Hill Interiors — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "notting-hill-interiors",
  name: "Notting Hill Interiors",
  origin: "https://nottinghillinteriors.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Notting Hill Interiors Online",
    ...options,
  });
}
