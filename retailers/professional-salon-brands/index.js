/**
 * Professional Salon Brands NZ — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "professional-salon-brands",
  name: "Professional Salon Brands NZ",
  origin: "https://professionalsalonbrands.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Professional Salon Brands NZ Online",
    ...options,
  });
}
