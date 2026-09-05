/**
 * HyperDrive — NZ tyres, wheels and automotive accessories retailer.
 *
 * Platform: N2 ERP (.NET) storefront with server-rendered category grids.
 * Category pages (/products/category/<id>/<slug>?page=N) render 32 product
 * tiles with data-productid, brand image alt-text, and price spans.
 * Verified live 2026-09-06 (see README.md).
 */

import { HtmlGridClient } from "../_lib/html-grid.js";

export const RETAILER = {
  slug: "hyperdrive",
  name: "HyperDrive",
  origin: "https://www.hyperdrive.co.nz",
  platform: "ssr-tiles",
};

/** Category paths (nav-verified 2026-09-06). */
export const CATEGORIES = [
  "/products/category/227/tyres",
  "/products/category/2169/used-tyres",
];

const PROFILE = {
  tileStart: /<div class="product">/g,
  id: [/data-productid="(\d+)"/],
  name: [/class="name">\s*([^<]{2,150})\s*</],
  linkClass: "product-content",
  finalPrice: [/class="price grid">\s*<span>\s*\$([\d,.]+)/, /class="price[^"]*"[^>]*>\s*\$([\d,.]+)/],
  wasPrice: [/<del[^>]*>\s*\$([\d,.]+)/, /class="line-through">\s*\$([\d,.]+)/],
  brand: [/images\/brands\/[^"]*"[^>]*alt="([^"]+)"/],
  image: false,
};

export function createClient(options = {}) {
  return new HtmlGridClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "HyperDrive Online",
    categories: options.categories ?? CATEGORIES,
    profile: PROFILE,
    pageParam: "page",
    ...options,
  });
}
