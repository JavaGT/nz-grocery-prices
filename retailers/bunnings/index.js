/**
 * Bunnings Warehouse NZ — hardware and garden chain.
 *
 * Platform: Next.js with a dehydrated react-query state. Leaf category
 * pages (/products/<hub>/<leaf>?page=N) embed Coveo search results (36
 * per page, NZD prices) inside __NEXT_DATA__. Verified live 2026-09-06
 * (see README.md).
 */

import { NextDataClient } from "../_lib/next-data.js";

export const RETAILER = {
  slug: "bunnings",
  name: "Bunnings Warehouse NZ",
  origin: "https://www.bunnings.co.nz",
  platform: "next-data",
};

/** Verified leaf categories under /products/ (nav-verified 2026-09-06). */
export const CATEGORIES = [
  "products/garden/plants",
  "products/garden/gardening",
  "products/garden/pest-control",
  "products/garden/lawn",
  "products/garden/plant-pots-planters-baskets",
  "products/garden/garden-hand-tools",
];

export function createClient(options = {}) {
  return new NextDataClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Bunnings NZ Online",
    categories: options.categories ?? CATEGORIES,
    pageSize: 36,
    ...options,
  });
}
