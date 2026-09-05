/**
 * Whitcoulls — NZ retailer.
 *
 * Platform: eStar storefront with window.category JSON (?p=N paging).
 * Verified live 2026-09-06 (see README.md).
 */

import { EstarCategoryClient } from "../_lib/estar-category.js";

export const RETAILER = {
  slug: "whitcoulls",
  name: "Whitcoulls",
  origin: "https://www.whitcoulls.co.nz",
  platform: "estar-json",
};

/** Category paths (nav-verified 2026-09-06). */
export const CATEGORIES = [
  "books",
  "art-craft",
  "toys",
  "stationery",
  "games-puzzles",
  "gifts",
];

export function createClient(options = {}) {
  return new EstarCategoryClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Whitcoulls Online",
    categories: options.categories ?? CATEGORIES,
    // Server-side ?p=N paging verified live (art-craft ?p=2 disjoint).
    pageParam: options.pageParam ?? "p",
    ...options,
  });
}
