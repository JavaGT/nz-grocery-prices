/**
 * Super Liquor — NZ liquor store chain.
 *
 * Platform: nopCommerce storefront with a public Algolia index
 * (app 81Y7HZ6N3A, index "Products" — credentials embedded in the
 * storefront bundle). Empty-query browse walks the full ~7.7k product
 * catalog with prices. Verified live 2026-09-06 (see README.md).
 */

import { AlgoliaSearchClient } from "../_lib/algolia.js";
import { toCents } from "../_lib/observation.js";

export const RETAILER = {
  slug: "super-liquor",
  name: "Super Liquor",
  origin: "https://www.superliquor.co.nz",
  platform: "algolia",
};

/** Map a nopCommerce-in-Algolia hit to an observation spec. */
export function mapHit(hit) {
  const priceValue = Number(hit?.ProductPrice?.PriceValue);
  const currentCents = Number.isFinite(priceValue) ? toCents(priceValue) : undefined;
  if (currentCents === undefined || currentCents <= 0) return undefined;
  const oldValue = Number(hit?.ProductPrice?.OldPriceValue);
  const oldCents = Number.isFinite(oldValue) ? toCents(oldValue) : undefined;
  const onSale = oldCents !== undefined && oldCents > currentCents;
  const skuDigits = String(hit?.Sku ?? "").replace(/\D/g, "");
  return {
    retailerProductId: String(hit?.Id ?? hit?.objectID ?? ""),
    url: hit?.SeName ? `${RETAILER.origin}/${hit.SeName}` : undefined,
    name: hit?.Name,
    ...(skuDigits.length >= 6 && skuDigits.length <= 14 ? { gtin: skuDigits } : {}),
    image: hit?.PictureModels?.[0]?.ImageUrl ?? hit?.AutoCompleteImageUrl ?? undefined,
    regularCents: onSale ? oldCents : currentCents,
    ...(onSale ? { promoCents: currentCents } : {}),
  };
}

export function createClient(options = {}) {
  return new AlgoliaSearchClient({
    slug: RETAILER.slug,
    origin: RETAILER.origin,
    scopeName: "Super Liquor Online",
    appId: "81Y7HZ6N3A",
    apiKey: "2b092b5b231305252cb9275a0e4ddea6",
    indexName: "Products",
    pageSize: 500,
    // paginationLimitedTo (1000) hides everything past the first two pages;
    // slice the walk over the numeric Id field instead.
    sliceAttribute: "Id",
    sliceStep: 500,
    mapHit: (hit, ...rest) => mapHit(hit, ...rest),
    ...options,
  });
}
