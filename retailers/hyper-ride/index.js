/**
 * Hyper Ride — NZ action sports retailer (surf, skate, wake, snow, motox, MTB).
 *
 * Platform: custom Next.js SSR. /products/<collection> pages render the
 * product grid server-side: tile = div.product with a name div, a product
 * link (/product/<id>/<slug>), and price spans (line-through was-price +
 * now-price on specials). Verified live 2026-09-06 (see README.md).
 */

import { HtmlGridClient } from "../_lib/html-grid.js";

export const RETAILER = {
  slug: "hyper-ride",
  name: "Hyper Ride",
  origin: "https://www.hyperride.co.nz",
  platform: "ssr-tiles",
};

/** Collection paths (nav-verified 2026-09-06). */
export const CATEGORIES = ["products/clearance", "products/new-arrivals"];

const PROFILE = {
  tileStart: /<div class="product">/g,
  id: [/\/product\/(\d+)\//],
  name: [/class="name">\s*(?:<br\s*\/?>)?\s*([^<]{5,150})/],
  url: [/href="(\/product\/\d+\/[^"?]+)/],
  finalPrice: [
    /class="price special">\s*<span class="line-through">\$[\d,.]+\s*<\/span>\s*\$([\d,.]+)/,
    /class="price"[^>]*>\s*\$([\d,.]+)/,
  ],
  wasPrice: [/class="price special">\s*<span class="line-through">\$([\d,.]+)/],
  image: true,
};

export function createClient(options = {}) {
  return new HtmlGridClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Hyper Ride Online",
    categories: options.categories ?? CATEGORIES,
    profile: PROFILE,
    ...options,
  });
}
