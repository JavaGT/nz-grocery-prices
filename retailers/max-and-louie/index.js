/**
 * Max & Louie — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "max-and-louie",
  name: "Max & Louie",
  origin: "https://maxandlouie.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Max & Louie Online",
    ...options,
  });
}
