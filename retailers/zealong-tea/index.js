/**
 * Zealong Tea Estate — NZ retailer.
 *
 * Platform: WooCommerce with the public Store API enabled. Verified live
 * 2026-09-06 (see README.md).
 */

import { WooStoreClient } from "../_lib/woocommerce.js";

export const RETAILER = {
  slug: "zealong-tea",
  name: "Zealong Tea Estate",
  origin: "https://zealong.com",
  platform: "woocommerce",
};

export function createClient(options = {}) {
  return new WooStoreClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Zealong Tea Estate Online",
    pageSize: 50,
    ...options,
  });
}
