/**
 * NZ Candle Supplies — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "nz-candle-supplies",
  name: "NZ Candle Supplies",
  origin: "https://nzcandlesupplies.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "NZ Candle Supplies Online",
    ...options,
  });
}
