/**
 * Wools of Wanaka — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "wools-of-wanaka",
  name: "Wools of Wanaka",
  origin: "https://woolsofwanaka.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Wools of Wanaka Online",
    ...options,
  });
}
