/**
 * Kmart NZ — budget department store chain.
 *
 * Platform: product discovery runs on Constructor.io (site key published
 * in the storefront bundle). The public search endpoint returns product
 * records with NZD variation pricing, brand, image, and GTIN — no
 * Akamai-protected page fetches needed. Catalog coverage via letter sweep.
 * Verified live 2026-09-06 (see README.md).
 */

import { ConstructorSearchClient } from "../_lib/constructor-io.js";

export const RETAILER = {
  slug: "kmart",
  name: "Kmart NZ",
  origin: "https://www.kmart.co.nz",
  platform: "constructor-io",
};

export const CONSTRUCTOR_KEY = "key_EyiTrcbGw7IFH3wR";

/** Query sweep across the alphabet plus high-volume terms. */
export const QUERIES = "abcdefghijklmnopqrstuvwxyz".split("");

export function createClient(options = {}) {
  return new ConstructorSearchClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Kmart NZ Online",
    key: CONSTRUCTOR_KEY,
    queries: options.queries ?? QUERIES,
    pageSize: 100,
    maxPagesPerQuery: 3,
    ...options,
  });
}
