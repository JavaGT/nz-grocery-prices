/**
 * Supercheap Auto New Zealand — auto parts and accessories.
 *
 * Platform: SFCC. Storefront pages are server-rendered classic tiles at
 * plain category paths (/<category>?start=N&sz=N); /shop/* and the
 * demandware controllers return 410. Sale tiles carry
 * product-sales-price (Now) and product-standard-price (Was) spans; every
 * tile also embeds a percent-encoded GTM payload with the price.
 * Verified live 2026-09-06 (see README.md).
 */

import { HtmlGridClient } from "../_lib/html-grid.js";

export const RETAILER = {
  slug: "supercheap-auto",
  name: "Supercheap Auto New Zealand",
  origin: "https://www.supercheapauto.co.nz",
  platform: "sfcc-html-grid",
};

/** Top-level category paths (nav/PDP-verified 2026-09-06). */
export const CATEGORIES = [
  "4wd-touring",
  "batteries-electrical",
  "car-care-cleaning",
  "diy-car-servicing-essentials",
  "oils-fluids-filters",
  "marine",
  "motorcycle",
  "best-sellers",
  "bonus-buys",
  "clearance",
];

const PROFILE = {
  tileStart: /<div[^>]*class="product-tile[ "]/g,
  id: [/\/p\/[a-z0-9%.-]+\/(\d+)\.html/],
  name: [/class="thumb-link"[^>]*title="([^"]+)"/, /class="name-link"[^>]*title="([^"]+)"/],
  linkClass: "thumb-link",
  finalPrice: [
    /class="product-sales-price[^"]*"[^>]*>[\s\S]{0,250}?class="the-price">\s*\$([\d,.]+)/,
    /%22price%22%3A([\d.]+)/,
    /class="the-price">\s*\$([\d,.]+)/,
  ],
  wasPrice: [
    /class="product-standard-price[^"]*">[\s\S]{0,250}?class="the-price">\s*\$([\d,.]+)/,
    /%22wasPrice%22%3A([\d.]+)/,
  ],
  brand: [/class="brand-name">\s*([^<]+?)\s*</, /%22item_brand%22%3A%22([^%"]+)%22/],
  image: true,
};

export function createClient(options = {}) {
  return new HtmlGridClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Supercheap Auto NZ Online",
    categories: options.categories ?? CATEGORIES,
    profile: PROFILE,
    pagination: "offset",
    pageSize: 24,
    ...options,
  });
}
