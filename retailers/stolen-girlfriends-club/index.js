/**
 * Stolen Girlfriends Club — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live 2026-09-06
 * (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "stolen-girlfriends-club",
  name: "Stolen Girlfriends Club",
  origin: "https://stolengirlfriendsclub.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Stolen Girlfriends Club Online",
    ...options,
  });
}
