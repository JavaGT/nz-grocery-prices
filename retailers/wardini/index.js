/**
 * Wardini Books — Hawke's Bay independent bookshop (Nielsen Bookshop of
 * the Year 2020).
 *
 * Platform: Circlesoft bookshop software. The homepage carousels are
 * server-rendered with fully attributed book tiles: data-barcode (ISBN-13),
 * data-product-name, data-product-price (NZD), data-product-category.
 * Deeper category pages render client-side, so the homepage is the
 * collection source. Verified live 2026-09-06 (see README.md).
 */

import { HtmlGridClient } from "../_lib/html-grid.js";

export const RETAILER = {
  slug: "wardini",
  name: "Wardini Books",
  origin: "https://wardini.co.nz",
  platform: "ssr-tiles",
};

/** The homepage carries all category carousels in one document. */
export const CATEGORIES = ["/"];

const PROFILE = {
  tileStart: /<a[^>]*class="product-thumb-name"/g,
  id: [/data-barcode="(97[89]\d{9}[\dXx])"/, /data-barcode="([^"]+)"/],
  name: [/data-product-name="([^"]+)"/],
  url: [/href="(\/p\/[^"]+)"/],
  finalPrice: [/data-product-price="([\d.]+)"/],
  wasPrice: [],
  brand: [/data-product-category="([^"]+)"/],
  image: false,
};

export function createClient(options = {}) {
  return new HtmlGridClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Wardini Books Online",
    categories: options.categories ?? ["/"],
    profile: PROFILE,
    ...options,
  });
}
