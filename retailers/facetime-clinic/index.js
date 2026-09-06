/**
 * Facetime Skin Clinic — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "facetime-clinic",
  name: "Facetime Skin Clinic",
  origin: "https://facetimeclinic.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Facetime Skin Clinic Online",
    ...options,
  });
}
