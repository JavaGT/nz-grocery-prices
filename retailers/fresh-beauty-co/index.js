/**
 * Fresh Beauty Co NZ — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "fresh-beauty-co",
  name: "Fresh Beauty Co NZ",
  origin: "https://freshbeautyco.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Fresh Beauty Co NZ Online",
    ...options,
  });
}
