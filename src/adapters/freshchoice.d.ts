/**
 * Public contract for nz-grocery-prices/freshchoice. Hand-maintained like
 * src/index.d.ts; domain shapes are local copies (see that file).
 */
/**
 * Domain shapes come from the SHARED public contract —
 * src/domain/observation.d.ts is the single source; importing it here
 * (instead of copying) is what keeps the copies from drifting.
 */
import type { PriceObservation, Store } from "../domain/observation.js";
export type { PriceObservation, Store };

export interface FreshChoiceClientOptions {
  origin?: string;
  storeSlug?: string;
  storeName?: string;
  storeAddress?: string;
  userAgent?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export interface FreshChoiceCollectOptions {
  page?: number;
  maxPages?: number;
  query?: string;
  observedAt?: string;
}

export interface FreshChoiceProduct {
  id: string;
  name: string;
  path: string;
  sellCents: number;
  wasCents?: number;
  unit?: string;
  comparative?: string;
  image?: string;
  isSpecial: boolean;
  classes: string[];
}

export interface FreshChoiceStore {
  id: string;
  slug: string;
  retailer: "freshchoice";
  name: string;
  address?: string;
  origin: string;
}

export class FreshChoiceClient {
  constructor(options?: FreshChoiceClientOptions);
  origin: string;
  storeSlug: string;
  storeName: string;
  storeAddress?: string;
  userAgent: string;
  /** Storefront list source; override via options.storeListUrl. */
  storeListUrl?: string;
  getStore(): Store & { retailer: "freshchoice"; origin: string };
  /** Every FreshChoice storefront parsed from the store-list page. */
  listStores(): Promise<FreshChoiceStore[]>;
  listDeals(options?: FreshChoiceCollectOptions): Promise<string>;
  searchProducts(options: FreshChoiceCollectOptions & { query: string }): Promise<string>;
  collectDeals(options?: FreshChoiceCollectOptions): Promise<PriceObservation[]>;
  collectProducts(options: FreshChoiceCollectOptions & { query: string }): Promise<PriceObservation[]>;
}

export function parseFreshChoiceProducts(html: string): FreshChoiceProduct[];
export function parseFreshChoiceStoreList(html: string): FreshChoiceStore[];
export function toFreshChoiceObservation(
  product: FreshChoiceProduct,
  store: Store,
  options?: { observedAt?: string; origin?: string },
): PriceObservation | undefined;
