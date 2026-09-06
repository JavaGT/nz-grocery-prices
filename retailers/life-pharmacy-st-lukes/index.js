/**
 * Life Pharmacy St Lukes — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "life-pharmacy-st-lukes",
  name: "Life Pharmacy St Lukes",
  origin: "https://lifepharmacystlukes.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Life Pharmacy St Lukes Online",
    ...options,
  });
}
