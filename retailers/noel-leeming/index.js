/**
 * Noel Leeming — NZ consumer electronics and appliances chain.
 *
 * Platform: SFCC (classic). `Search-UpdateGrid` 301s to the same
 * /search/updategrid endpoint The Warehouse uses, and the product tiles
 * carry the identical data-gtm-product payload, so this adapter reuses the
 * warehouse transformers. Verified live 2026-09-06 (see README.md).
 */

import { SfccUpdateGridClient } from "../_lib/sfcc-updategrid.js";

export const RETAILER = {
  slug: "noel-leeming",
  name: "Noel Leeming",
  origin: "https://www.noelleeming.co.nz",
  platform: "sfcc-updategrid",
};

/** Top-level /c/<cgid> categories (nav-verified 2026-09-06). */
export const CATEGORIES = [
  "appliances",
  "audio",
  "computers-office-tech",
  "gaming",
  "home-entertainment",
  "mobile-smart-devices",
  "photo-video",
  "smart-home",
  "hot-deals",
];

export function createClient(options = {}) {
  return new SfccUpdateGridClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Noel Leeming Online",
    categories: options.categories ?? CATEGORIES,
    ...options,
  });
}
