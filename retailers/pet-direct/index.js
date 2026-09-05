/**
 * Petdirect — NZ online pet supplies store.
 *
 * Platform: BigCommerce (Stencil), server-rendered product cards on
 * /c/<category>/ pages with ?page=N pagination. Cards carry
 * data-product-id, brand in <strong>, current price in the first
 * card-price span, and an RRP ("why pay?") stack on discounted items.
 * Verified live 2026-09-06 (see README.md).
 */

import { HtmlGridClient } from "../_lib/html-grid.js";

export const RETAILER = {
  slug: "pet-direct",
  name: "Petdirect",
  origin: "https://www.petdirect.co.nz",
  platform: "bigcommerce-html",
};

/** Top-level /c/ categories (nav-verified 2026-09-06). */
export const CATEGORIES = ["/c/dog/", "/c/cat/", "/c/pet-health/", "/c/top-picks/"];

const PROFILE = {
  tileStart: /<article[^>]*class="product-card[ "]/g,
  id: [/data-product-id="(\d+)"/],
  name: [/<img[^>]*class="[^"]*card-image[^"]*"[^>]*alt="([^"]+)"/],
  url: [/href="(https:\/\/[a-z.]*petdirect\.co\.nz\/p\/[^"]+)"/, /href="(\/p\/[^"]+)"/],
  finalPrice: [/class="card-price">\s*\$([\d,.]+)/],
  wasPrice: [/price-stack--rrp[\s\S]{0,300}?class="card-price">\s*\$<span>([\d,.]+)/],
  brand: [/product-card-name[\s\S]{0,250}?<strong>([^<]+)<\/strong>/],
  image: true,
};

export function createClient(options = {}) {
  return new HtmlGridClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Petdirect Online",
    categories: options.categories ?? CATEGORIES,
    profile: PROFILE,
    pageParam: "page",
    pageSize: 24,
    ...options,
  });
}
