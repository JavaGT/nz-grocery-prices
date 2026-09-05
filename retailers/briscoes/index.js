/**
 * Briscoes — NZ homeware chain.
 *
 * Platform: Magento 2 GraphQL, shared with Rebel Sport (same backend);
 * default store view is already `briscoes`. Category walk via url_key
 * ids. Verified live 2026-09-06 (see README.md).
 */

import { MagentoGraphqlClient } from "../_lib/magento-graphql.js";

export const RETAILER = {
  slug: "briscoes",
  name: "Briscoes",
  origin: "https://www.briscoes.co.nz",
  platform: "magento-graphql",
};

/** Top-level category url_keys (GraphQL tree, 2026-09-06). */
export const CATEGORIES = [
  "new-in",
  "bed-and-bath",
  "bath",
  "cleaning-laundry",
  "dining",
  "kitchen",
  "kids-nursery",
  "electrical",
  "outdoor",
  "travel",
  "sale",
];

export function createClient(options = {}) {
  return new MagentoGraphqlClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Briscoes Online",
    storeCode: "briscoes",
    categories: options.categories ?? CATEGORIES,
    ...options,
  });
}
