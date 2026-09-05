/**
 * Number One Shoes + Hannahs — NZ footwear retailer.
 *
 * Platform: Black Pepper/eStar family (same as Liquorland/Glassons) —
 * category pages embed the full payload as window.category = { ...{...} }
 * with server-side ?p=N pagination (24 items/page).
 * Verified live 2026-09-06 (see README.md).
 */

import { EstarCategoryClient } from "../_lib/estar-category.js";

export const RETAILER = {
  slug: "number-one-shoes",
  name: "Number One Shoes + Hannahs",
  origin: "https://www.numberoneshoesandhannahs.co.nz",
  platform: "black-pepper-json",
};

/** Category paths (nav-verified 2026-09-06). */
export const CATEGORIES = ["mens", "womens", "kids", "clearance"];

export function createClient(options = {}) {
  return new EstarCategoryClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Number One Shoes Online",
    categories: options.categories ?? CATEGORIES,
    pageParam: "p",
    ...options,
  });
}
