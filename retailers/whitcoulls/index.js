/**
 * Whitcoulls — NZ retailer.
 *
 * Platform: eStar storefront with window.category JSON (page 1 per category).
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
    ...options,
  });
}
