/**
 * Animates — NZ pet supplies chain.
 *
 * Platform: Magento 2 (classic server-rendered listings; GraphQL disabled).
 * Tiles identify by SKU meta tag and price lives in price-box meta tags.
 * Verified live 2026-09-06 (see README.md).
 */

import { HtmlGridClient } from "../_lib/html-grid.js";

export const RETAILER = {
  slug: "animates",
  name: "Animates",
  origin: "https://www.animates.co.nz",
  platform: "magento-html",
};

/** Top-level nav categories with server-rendered grids (nav-verified). */
export const CATEGORIES = ["dog", "cat", "bird", "fish", "small-pet", "reptile", "chicken", "specials-all"];

const PROFILE = {
  tileStart: /<li[^>]*class="[^"]*\bproduct product-item\b[^"]*"/g,
  id: [/Product SKU\s*-->\s*<meta\s+content="([^"]+)"/, /<meta\s+content="(I\d+|[A-Z]\d+)"/],
  name: [/<span class="product-name"\s*>\s*([^<]+?)\s*</, /<img[^>]*\balt="([^"]+)"/],
  linkClass: "product-item-link",
  finalPrice: [
    /<div class="price-box"\s*>\s*<meta\s+content="[^"]*"\s*\/>\s*<meta\s+content="([\d.]+)"/,
    /<span class="price">\s*\$([\d,.]+)/,
  ],
  wasPrice: [
    /<span class="old-price">[\s\S]{0,300}?<span class="price">\s*\$([\d,.]+)/,
    /data-price-type="oldPrice"[^>]*data-price-amount="([\d.]+)"/,
  ],
  image: true,
};

export function createClient(options = {}) {
  return new HtmlGridClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Animates Online",
    categories: options.categories ?? CATEGORIES,
    profile: PROFILE,
    ...options,
  });
}
