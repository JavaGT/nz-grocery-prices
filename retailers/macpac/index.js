/**
 * Macpac — NZ outdoor clothing and gear chain.
 *
 * Platform: SFCC (server-rendered category grids; Search-UpdateGrid and
 * Search-Update are 410-Gone). Category pages paginate with ?start=N&sz=N
 * and tiles expose data-itemid, thumb-link anchors, standard/member price
 * spans, and a gtm-product-data JSON input. Member pricing maps onto
 * price.memberCents. Verified live 2026-09-06 (see README.md).
 */

import { HtmlGridClient } from "../_lib/html-grid.js";

export const RETAILER = {
  slug: "macpac",
  name: "Macpac",
  origin: "https://www.macpac.co.nz",
  platform: "sfcc-html-grid",
};

/** Top-level nav categories (nav-verified 2026-09-06). */
export const CATEGORIES = [
  "all-clothing",
  "backpacks-bags",
  "tents-shelters",
  "sleeping-bags",
  "camping-hiking",
  "footwear",
  "climbing",
  "snow",
];

const PROFILE = {
  tileStart: /<div[^>]*class="product-tile"/g,
  id: [/data-itemid="(\d+)"/],
  name: [/class="thumb-link"[^>]*title="([^"]+)"/, /"item_name":"([^"]+)"/],
  linkClass: "thumb-link",
  finalPrice: [/class="price-standard[^"]*">\s*NZ\$([\d,.]+)/, /"price":([\d.]+),/],
  wasPrice: [],
  // Macpac's members price: price-sales span under a club-price label.
  memberPrice: [/class="price-value">\s*NZ\$([\d,.]+)/],
  brand: [/"item_brand":"([^"]+)"/],
  image: true,
};

export function createClient(options = {}) {
  return new HtmlGridClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Macpac Online",
    categories: options.categories ?? CATEGORIES,
    profile: PROFILE,
    pagination: "offset",
    pageSize: 24,
    ...options,
  });
}
