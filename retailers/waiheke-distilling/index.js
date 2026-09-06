/**
 * Waiheke Distilling — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "waiheke-distilling",
  name: "Waiheke Distilling",
  origin: "https://waihekedistilling.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Waiheke Distilling Online",
    ...options,
  });
}
