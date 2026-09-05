/**
 * Scorpio Books — Christchurch independent bookshop.
 *
 * Platform: WooCommerce with the public Store API enabled
 * (/wp-json/wc/store/v1/products). Verified live 2026-09-06
 * (see README.md).
 */

import { WooStoreClient } from "../_lib/woocommerce.js";

export const RETAILER = {
  slug: "scorpio-books",
  name: "Scorpio Books",
  origin: "https://scorpiobooks.co.nz",
  platform: "woocommerce",
};

export function createClient(options = {}) {
  return new WooStoreClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Scorpio Books Online",
    pageSize: 50,
    ...options,
  });
}
