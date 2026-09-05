/**
 * PB Tech — NZ computer and electronics retailer.
 *
 * Platform: custom (Next-style SSR). Category pages render ~90 product
 * tiles server-side; each tile's name anchor carries data-product-code and
 * a title, and prices render as "PB Tech price" full-price spans where the
 * GST-inclusive (ginc) block is the retail price. Pagination is
 * client-side, so the walk covers page 1 of each configured category.
 * Verified live 2026-09-06 (see README.md).
 */

import { HtmlGridClient } from "../_lib/html-grid.js";

export const RETAILER = {
  slug: "pbtech",
  name: "PB Tech",
  origin: "https://www.pbtech.co.nz",
  platform: "ssr-tiles",
};

/** Top-level category paths (nav-verified 2026-09-06). */
export const CATEGORIES = [
  "category/Computers/Laptops",
  "category/Computers/PCs",
  "category/Headphones-Audio/Headphones",
  "category/Peripherals/Monitors",
  "category/Peripherals/Cables",
  "category/Phones-GPS/Smartphones",
];

const PROFILE = {
  tileStart: /<div[^>]*class="product-title-holder"/g,
  id: [/data-product-code=['"]([A-Z0-9]+)['"]/],
  // listing tiles carry the name as an <h2 class="np_title"> (+ optional
  // <h3>) pair; some anchors also have a title attribute
  name: [
    /<h2 class="np_title[^"]*">([\s\S]{0,400}?)<\/h2>/,
    /js-product-link[^>]*title=['"]([^'"]{10,300})['"]/,
  ],
  joinName: true,
  // main product anchor sits outside the title-holder slice
  urlFromId: "/product/{id}",
  finalPrice: [
    /class="ginc"[\s\S]{0,400}?full-price">\s*\$([\d,.]+)/,
    /full-price">\s*\$([\d,.]+)/,
  ],
  wasPrice: [
    /class="price-was[^"]*">\s*\$([\d,.]+)/,
    /(?:was|save)[^$]{0,40}\$([\d,.]+)/i,
  ],
  image: false,
};

export function createClient(options = {}) {
  return new HtmlGridClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "PB Tech Online",
    categories: options.categories ?? CATEGORIES,
    profile: PROFILE,
    // category pages are single-page SSR; maxPages stays 1 per category
    pageSize: 90,
    ...options,
  });
}
