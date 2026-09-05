/**
 * Book Hound — NZ second-hand and discount bookstore.
 *
 * Platform: Circlesoft bookshop software (same family as Wardini) — the
 * homepage carousels are server-rendered with fully attributed book tiles:
 * data-barcode (ISBN-13), data-product-name, data-product-price (NZD),
 * data-product-category. Verified live 2026-09-06 (see README.md).
 */

import { HtmlGridClient } from "../_lib/html-grid.js";

export const RETAILER = {
  slug: "book-hound",
  name: "Book Hound",
  origin: "https://bookhound.co.nz",
  platform: "ssr-tiles",
};

/** The homepage carries the featured/new-arrival carousels. */
export const CATEGORIES = ["/"];

const PROFILE = {
  tileStart: /data-product-name=/g,
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
    scopeName: "Book Hound Online",
    categories: options.categories ?? CATEGORIES,
    profile: PROFILE,
    ...options,
  });
}
