/**
 * Hard to Find (but worth it) — NZ's largest second-hand bookstore
 * (Dunedin; online listings updated daily).
 *
 * Platform: custom legacy storefront, fully server-rendered. Subject
 * listings (/book/subject/<subject>?page=N, 20 books/page) carry
 * structured book-result tiles with data-bookid, data-title, author, and
 * price. Verified live 2026-09-06 (see README.md).
 */

import { HtmlGridClient } from "../_lib/html-grid.js";

export const RETAILER = {
  slug: "hard-to-find",
  name: "Hard to Find",
  origin: "https://www.hardtofind.co.nz",
  platform: "ssr-tiles",
};

/** Subject listing paths (nav-verified 2026-09-06). */
export const CATEGORIES = [
  "book/subject/fiction",
  "book/subject/biography",
  "book/subject/arts",
  "book/subject/aviation",
  "book/subject/business",
  "book/subject/antiques",
];

const PROFILE = {
  tileStart: /<div class="book-result">/g,
  id: [/data-bookid="([^"]+)"/],
  name: [/data-title="([^"]{2,300})"/, /class="book-result-title">([^<]{2,300})</],
  url: [/href="(\/book\/[^"]+)"/],
  finalPrice: [/class="book-result-price">\s*\$([\d,.]+)/],
  wasPrice: [],
  image: false,
};

export function createClient(options = {}) {
  return new HtmlGridClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Hard to Find Online",
    categories: options.categories ?? CATEGORIES,
    profile: PROFILE,
    pageParam: "page",
    ...options,
  });
}
