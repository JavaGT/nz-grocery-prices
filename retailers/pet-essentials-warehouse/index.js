/**
 * Pet Essentials Warehouse — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live 2026-09-06
 * (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "pet-essentials-warehouse",
  name: "Pet Essentials Warehouse",
  origin: "https://petessentialswarehouse.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Pet Essentials Warehouse Online",
    ...options,
  });
}
