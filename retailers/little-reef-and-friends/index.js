/**
 * Little Reef and Friends — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "little-reef-and-friends",
  name: "Little Reef and Friends",
  origin: "https://littlereefandfriends.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Little Reef and Friends Online",
    ...options,
  });
}
