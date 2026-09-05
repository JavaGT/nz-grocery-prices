/**
 * The New Zealand Honey Co — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live 2026-09-06
 * (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "nz-honey-co",
  name: "The New Zealand Honey Co",
  origin: "https://www.newzealandhoneyco.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "The New Zealand Honey Co Online",
    ...options,
  });
}
