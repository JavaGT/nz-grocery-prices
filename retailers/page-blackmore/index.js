/**
 * Page & Blackmore Booksellers — Nelson independent bookshop.
 *
 * Platform: WooCommerce with the public Store API enabled. Verified live
 * 2026-09-06 (see README.md).
 */

import { WooStoreClient } from "../_lib/woocommerce.js";

export const RETAILER = {
  slug: "page-blackmore",
  name: "Page & Blackmore Booksellers",
  origin: "https://www.pageandblackmore.co.nz",
  platform: "woocommerce",
};

export function createClient(options = {}) {
  return new WooStoreClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Page & Blackmore Online",
    pageSize: 50,
    ...options,
  });
}
