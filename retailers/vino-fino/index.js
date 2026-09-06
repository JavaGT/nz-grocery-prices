/**
 * Vino Fino — NZ wine retailer.
 *
 * Platform: WooCommerce with the public Store API enabled. Verified live
 * 2026-09-06 (see README.md).
 */

import { WooStoreClient } from "../_lib/woocommerce.js";

export const RETAILER = {
  slug: "vino-fino",
  name: "Vino Fino",
  origin: "https://vinofino.co.nz",
  platform: "woocommerce",
};

export function createClient(options = {}) {
  return new WooStoreClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Vino Fino Online",
    pageSize: 50,
    ...options,
  });
}
