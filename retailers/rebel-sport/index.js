/**
 * Rebel Sport — NZ sporting goods chain.
 *
 * Platform: Magento 2 GraphQL, shared with Briscoes (same backend) — the
 * `Store: rebelsport` header selects the Rebel store view. Category walk
 * via url_key-resolved ids. Verified live 2026-09-06 (see README.md).
 */

import { MagentoGraphqlClient } from "../_lib/magento-graphql.js";

export const RETAILER = {
  slug: "rebel-sport",
  name: "Rebel Sport",
  origin: "https://www.rebelsport.co.nz",
  platform: "magento-graphql",
};

/** Top-level category url_keys (GraphQL tree, 2026-09-06). */
export const CATEGORIES = [
  "new-in",
  "clothing",
  "footwear",
  "fangear",
  "equipment",
  "outdoors",
  "kids",
  "mens",
  "womens",
  "sale",
];

export function createClient(options = {}) {
  return new MagentoGraphqlClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Rebel Sport Online",
    storeCode: "rebelsport",
    categories: options.categories ?? CATEGORIES,
    ...options,
  });
}
