/**
 * Glassons — NZ retailer.
 *
 * Platform: Black Pepper (same stack as Liquorland/Postie) — category pages
embed the full payload as `window.category = { ...{...} }`. The `/nz`
prefix selects the NZ store view (locale "nz", NZD prices). Grid pagination
is client-side (infinite scroll), so the walk covers page 1 per category.
 * Verified live 2026-09-06 (see README.md).
 */

import { EstarCategoryClient } from "../_lib/estar-category.js";

export const RETAILER = {
  slug: "glassons",
  name: "Glassons",
  origin: "https://www.glassons.com",
  platform: "black-pepper-json",
};

/** Category paths (nav-verified 2026-09-06). */
export const CATEGORIES = [
  "nz/c/clothing",
  "nz/c/new",
  "nz/c/best-sellers",
  "nz/c/sale",
  "nz/c/accessories",
];

export function createClient(options = {}) {
  return new EstarCategoryClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Glassons NZ Online",
    categories: options.categories ?? CATEGORIES,
    ...options,
  });
}
