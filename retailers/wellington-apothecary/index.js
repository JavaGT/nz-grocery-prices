/**
 * Wellington Apothecary — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "wellington-apothecary",
  name: "Wellington Apothecary",
  origin: "https://wellingtonapothecary.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Wellington Apothecary Online",
    ...options,
  });
}
