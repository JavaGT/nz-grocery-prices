/**
 * Postie — NZ retailer.
 *
 * Platform: Black Pepper (same stack as Liquorland/Glassons) — category
pages embed the full payload as `window.category = { ...{...} }` (locale
"nz", NZD). Verified /womens: 524 price keys in the embedded payload.
 * Verified live 2026-09-06 (see README.md).
 */

import { EstarCategoryClient } from "../_lib/estar-category.js";

export const RETAILER = {
  slug: "postie",
  name: "Postie",
  origin: "https://www.postie.co.nz",
  platform: "black-pepper-json",
};

/** Category paths (nav-verified 2026-09-06). */
export const CATEGORIES = [
  "womens",
  "mens",
  "kids",
  "baby",
  "sleepwear",
  "underwear",
  "sale-clearance",
];

export function createClient(options = {}) {
  return new EstarCategoryClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Postie Online",
    categories: options.categories ?? CATEGORIES,
    ...options,
  });
}
