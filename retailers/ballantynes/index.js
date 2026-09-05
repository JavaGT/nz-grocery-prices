/**
 * Ballantynes — Christchurch department store.
 *
 * Platform: Salesforce Commerce Cloud (Demandware) with SSR product
 * tiles. Each tile's name anchor carries a data-cbt tracking JSON
 * (URL-encoded) with item_id/price/discount/item_brand; the tile price
 * block shows "Was" (strike-through list) and "Now" values.
 * Pagination: ?start=N&sz=24. Verified live 2026-09-06 (see README.md).
 */

import { HtmlGridClient } from "../_lib/html-grid.js";

export const RETAILER = {
  slug: "ballantynes",
  name: "Ballantynes",
  origin: "https://www.ballantynes.co.nz",
  platform: "sfcc-html-grid",
};

/** Top-level category paths (nav-verified 2026-09-06). */
export const CATEGORIES = ["womens", "beauty", "mens", "home", "kids", "jewellery-accessories"];

const PROFILE = {
  tileStart: /<div class="pdp-link">/g,
  id: [/item_id&quot;:&quot;(\d+)/],
  name: [/product-tile-name-anchor-link[\s\S]{0,1600}?itemprop="url"> ?([^<]{5,200}) ?</],
  url: [/href="(\/[a-z0-9-]+\/\d+\.html)"/],
  finalPrice: [/&quot;price&quot;:(\d+(?:\.\d+)?),/],
  wasPrice: [/class="strike-through list">\s*<span class="value"[^>]*>\s*\$([\d,]+)/],
  brand: [/item_brand&quot;:&quot;((?:[^&]|&(?!quot;))*)&quot;/],
  image: false,
};

export function createClient(options = {}) {
  return new HtmlGridClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Ballantynes Online",
    categories: options.categories ?? CATEGORIES,
    profile: PROFILE,
    pagination: "offset",
    pageSize: 24,
    ...options,
  });
}
