/**
 * Art Collective NZ — NZ retailer.
 *
 * Platform: WooCommerce with the public Store API enabled. Verified live
 * 2026-09-06 (see README.md).
 */

import { WooStoreClient } from "../_lib/woocommerce.js";

export const RETAILER = {
  slug: "art-collective",
  name: "Art Collective NZ",
  origin: "https://artcollective.co.nz",
  platform: "woocommerce",
};

export function createClient(options = {}) {
  return new WooStoreClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Art Collective NZ Online",
    pageSize: 50,
    ...options,
  });
}
