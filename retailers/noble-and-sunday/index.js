/**
 * Noble & Sunday Tea Merchants — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "noble-and-sunday",
  name: "Noble & Sunday Tea Merchants",
  origin: "https://nobleandsunday.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Noble & Sunday Tea Merchants Online",
    ...options,
  });
}
