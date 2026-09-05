/**
 * Hunting & Fishing New Zealand — outdoor/sports retail chain.
 *
 * Platform: Magento 2. The GraphQL endpoint answers storeConfig but the
 * products scope is empty (dead headless storefront), so this adapter walks
 * the server-rendered category grids: GET /<category>?p=N, tiles carry
 * data-product-id and priceBox data-price-amount attributes.
 * Verified live 2026-09-06 (see README.md).
 */

import { MagentoListClient } from "../_lib/magento-html.js";

export const RETAILER = {
  slug: "hunting-fishing",
  name: "Hunting & Fishing New Zealand",
  origin: "https://www.huntingandfishing.co.nz",
  platform: "magento-html",
};

/** Top-level nav categories that expose server-rendered product grids. */
export const CATEGORIES = ["hunting", "fishing", "camping", "clothing", "diving"];

const PROFILE = {
  tileStart: /<li[^>]*class="[^"]*\bproduct-item\b[^"]*"/g,
  id: [/data-product-id="(\d+)"/],
  name: [/class="product-item-link__name[^"]*">\s*([^<]+?)\s*</],
  linkClass: "product-item-link",
  finalPrice: [
    /data-price-type="finalPrice"[^>]*data-price-amount="([\d.]+)"/,
    /data-price-amount="([\d.]+)"[^>]*data-price-type="finalPrice"/,
  ],
  wasPrice: [
    /data-price-type="oldPrice"[^>]*data-price-amount="([\d.]+)"/,
    /data-price-amount="([\d.]+)"[^>]*data-price-type="oldPrice"/,
  ],
  image: true,
};

export function createClient(options = {}) {
  return new MagentoListClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Hunting & Fishing Online",
    categories: options.categories ?? CATEGORIES,
    profile: PROFILE,
    ...options,
  });
}
