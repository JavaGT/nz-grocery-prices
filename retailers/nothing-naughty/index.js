/**
 * Nothing Naughty — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live 2026-09-06
 * (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "nothing-naughty",
  name: "Nothing Naughty",
  origin: "https://www.nothingnaughty.kiwi.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Nothing Naughty Online",
    ...options,
  });
}
