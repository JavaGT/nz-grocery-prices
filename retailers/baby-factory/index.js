/**
 * Baby Factory — NZ retailer.
 *
 * Platform: eStar storefront with window.category JSON (page 1 per category).
 * Verified live 2026-09-06 (see README.md).
 */

import { EstarCategoryClient } from "../_lib/estar-category.js";

export const RETAILER = {
  slug: "baby-factory",
  name: "Baby Factory",
  origin: "https://www.babyfactory.co.nz",
  platform: "estar-json",
};

/** Category paths (nav-verified 2026-09-06). */
export const CATEGORIES = [
  "toys-gifts",
  "bath-changing",
  "nursery",
  "prams-travel",
  "car-seats",
  "feeding",
];

export function createClient(options = {}) {
  return new EstarCategoryClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Baby Factory Online",
    categories: options.categories ?? CATEGORIES,
    ...options,
  });
}
