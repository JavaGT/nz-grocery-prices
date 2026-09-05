/**
 * Aka Aka Brewing — NZ craft beer retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live 2026-09-06
 * (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "aka-aka-brewing",
  name: "Aka Aka Brewing",
  origin: "https://akaakabrewing.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Aka Aka Brewing Online",
    ...options,
  });
}
