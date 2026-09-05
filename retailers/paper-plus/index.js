/**
 * Paper Plus — NZ retailer.
 *
 * Platform: server-rendered product tiles via the shared html-grid client
 * (tile attrs carry clean tracking data (data-price/data-brand/data-url)). Verified live 2026-09-06 (see README.md).
 */

import { HtmlGridClient } from "../_lib/html-grid.js";

export const RETAILER = {
  slug: "paper-plus",
  name: "Paper Plus",
  origin: "https://www.paperplus.co.nz",
  platform: "html-grid",
};

/** Category paths (nav-verified 2026-09-06). */
export const CATEGORIES = [
  "/shop/art-craft",
  "/shop/books",
  "/shop/stationery",
  "/shop/games-puzzles",
  "/shop/kids-books",
  "/shop/gifts",
];

const PROFILE = {
  tileStart: /<(div|article)[^>]*data-productid="/g,
  id: [/data-productid="(\d+)"/],
  name: [/data-name="([^"]+)"/],
  linkClass: "js-productlink",
  url: [/data-url="([^"]+)"/],
  finalPrice: [/data-price="([\d.]+)"/, /class="item-price">\s*\$([\d,.]+)/],
  wasPrice: [/class="was">\s*\$([\d,.]+)/],
  brand: [/data-brand="([^"]+)"/],
  image: true,
};

export function createClient(options = {}) {
  return new HtmlGridClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Paper Plus Online",
    categories: options.categories ?? CATEGORIES,
    profile: PROFILE,
    pageParam: "page",
    ...options,
  });
}
