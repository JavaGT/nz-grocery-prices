/**
 * Babycity — NZ baby products retailer.
 *
 * Platform: Odoo (custom "tp" theme). Category pages
 * (/shop/category/<id-or-slug>?page=N) server-render 7-up product grids;
 * each tile carries a hidden product_id input, name anchor, and
 * data-oe monetary price spans (sale price first, original in <del>).
 * Requires the cookie acquired from a homepage hit — plain category
 * fetches 301-loop without it (fetch follows cookies per-connection; the
 * shared http client keeps cookies only inside a session, which Node's
 * fetch does per-process).
 * Verified live 2026-09-06 (see README.md).
 */

import { HtmlGridClient } from "../_lib/html-grid.js";

export const RETAILER = {
  slug: "babycity",
  name: "Babycity",
  origin: "https://www.babycity.co.nz",
  platform: "odoo-html",
};

/** Numeric category ids from the shop nav (2026-09-06). */
export const CATEGORIES = [
  "/shop/category/10",
  "/shop/category/11",
  "/shop/category/12",
  "/shop/category/103",
  "/shop/category/142",
  "/shop/category/193",
];

const PROFILE = {
  tileStart: /<input name="product_id"/g,
  id: [/name="product_id" type="hidden" value="(\d+)"/],
  name: [/<h6[^>]*>\s*<a[^>]*>([^<]+)<\/a>/],
  url: [/href="(\/shop\/[a-z0-9-]+\/[a-z0-9%-]+-\d+)"/],
  finalPrice: [/oe_currency_value">([\d,.]+)/],
  wasPrice: [/<del[^>]*>[\s\S]{0,200}?oe_currency_value">([\d,.]+)/],
  image: true,
};

export function createClient(options = {}) {
  return new HtmlGridClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Babycity Online",
    categories: options.categories ?? CATEGORIES,
    profile: PROFILE,
    pageParam: "page",
    ...options,
  });
}
