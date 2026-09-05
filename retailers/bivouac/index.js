/**
 * Bivouac Outdoor — NZ outdoor equipment and clothing chain (Auckland + online).
 *
 * Platform: Shopify public storefront JSON. Verified live 2026-09-06
 * (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "bivouac",
  name: "Bivouac Outdoor",
  origin: "https://www.bivouac.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Bivouac Outdoor Online",
    ...options,
  });
}
