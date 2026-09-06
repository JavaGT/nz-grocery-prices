/**
 * Indie Home Collective — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "indie-home-collective",
  name: "Indie Home Collective",
  origin: "https://indiehomecollective.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Indie Home Collective Online",
    ...options,
  });
}
