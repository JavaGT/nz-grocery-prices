/**
 * Harvey Norman NZ — NZ retailer.
 *
 * Platform: server-rendered product tiles via the shared html-grid client
 * (split $/amount price-num spans; tiles expose no was-price). Verified live 2026-09-06 (see README.md).
 */

import { HtmlGridClient } from "../_lib/html-grid.js";

export const RETAILER = {
  slug: "harvey-norman",
  name: "Harvey Norman NZ",
  origin: "https://www.harveynorman.co.nz",
  platform: "html-grid",
};

/** Category paths (nav-verified 2026-09-06). */
export const CATEGORIES = [
  "/whiteware/kitchen/",
  "/apple-computers/",
  "/bedroom/",
  "/computers/",
  "/tv-home-theatre/",
  "/small-appliances/",
];

const PROFILE = {
  tileStart: /<a[^>]*class="[^"]*product-title[^"]*"/g,
  id: [/product_link_(\d+)/],
  name: [/class="product-title[^"]*">([^<]+)</],
  url: [/href="([^"]+\.html)"/],
  finalPrice: [/price-num">\$<\/span><span[^>]*>([\d,]+)/, /price-num">([\d,]+)/],
  wasPrice: [],
  image: false,
};

export function createClient(options = {}) {
  return new HtmlGridClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Harvey Norman NZ Online",
    categories: options.categories ?? CATEGORIES,
    profile: PROFILE,
    pageParam: "page",
    ...options,
  });
}
