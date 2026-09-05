/**
 * Liquorland — NZ retailer.
 *
 * Platform: custom storefront with server-side category JSON (?p=N pagination).
 * Verified live 2026-09-06 (see README.md).
 */

import { EstarCategoryClient } from "../_lib/estar-category.js";

export const RETAILER = {
  slug: "liquorland",
  name: "Liquorland",
  origin: "https://www.liquorland.co.nz",
  platform: "window-category-json",
};

/** Category paths (nav-verified 2026-09-06). */
export const CATEGORIES = ["wine","beer","spirits","rtds","liqueurs","cider","non-alcoholic"];

export function createClient(options = {}) {
  return new EstarCategoryClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Liquorland Online",
    categories: options.categories ?? CATEGORIES,
    pageParam: "p",
    ...options,
  });
}
