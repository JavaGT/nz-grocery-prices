/**
 * The Fabric Store — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live 2026-09-06
 * (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "the-fabric-store",
  name: "The Fabric Store",
  origin: "https://thefabricstore.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "The Fabric Store Online",
    ...options,
  });
}
