/**
 * The Bottle-O — NZ retailer.
 *
 * Platform: server-rendered product tiles via the shared html-grid client
 * (Rails talker tiles; listing prices are current-only). Verified live 2026-09-06 (see README.md).
 */

import { HtmlGridClient } from "../_lib/html-grid.js";

export const RETAILER = {
  slug: "the-bottle-o",
  name: "The Bottle-O",
  origin: "https://thebottleo.co.nz",
  platform: "html-grid",
};

/** Category paths (nav-verified 2026-09-06). */
export const CATEGORIES = [
  "/category/beer",
  "/category/wine",
  "/category/spirits",
  "/category/cider",
];

const PROFILE = {
  tileStart: /<div[^>]*class="talker[ "]/g,
  id: [/id="line_([a-f0-9]{8,32})"/],
  name: [/class="talker__product-name">\s*([^<]+)/],
  url: [/href="(\/lines\/[^"]+)"/],
  finalPrice: [/class="price__sell"[^>]*>\s*\$([\d,.]+)/],
  wasPrice: [],
  image: true,
};

export function createClient(options = {}) {
  return new HtmlGridClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "The Bottle-O Online",
    categories: options.categories ?? CATEGORIES,
    profile: PROFILE,
    pageParam: "page",
    ...options,
  });
}
