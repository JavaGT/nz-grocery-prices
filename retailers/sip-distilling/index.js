/**
 * SIP Distilling Co. — NZ retailer.
 *
 * Platform: Shopify public storefront JSON. Verified live (see README.md).
 */

import { ShopifyCatalogClient } from "../_lib/shopify.js";

export const RETAILER = {
  slug: "sip-distilling",
  name: "SIP Distilling Co.",
  origin: "https://sipdistilling.co.nz",
  platform: "shopify",
};

export function createClient(options = {}) {
  return new ShopifyCatalogClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "SIP Distilling Co. Online",
    ...options,
  });
}
