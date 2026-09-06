/**
 * Electric Bike Rotorua — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "electric-bike-rotorua",
  name: "Electric Bike Rotorua",
  origin: "https://electricbikerotorua.com",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Electric Bike Rotorua Online",
    ...options,
  });
}
