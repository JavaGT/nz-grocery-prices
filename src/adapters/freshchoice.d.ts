import type { PriceObservation, Store } from "../index.js";

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

export class FreshChoiceClient {
  constructor(options?: FreshChoiceClientOptions);
  origin: string;
  storeSlug: string;
  storeName: string;
  storeAddress?: string;
  userAgent: string;
  getStore(): Store & { retailer: "freshchoice"; origin: string };
  listDeals(options?: FreshChoiceCollectOptions): Promise<string>;
  searchProducts(options: FreshChoiceCollectOptions & { query: string }): Promise<string>;
  collectDeals(options?: FreshChoiceCollectOptions): Promise<PriceObservation[]>;
  collectProducts(options: FreshChoiceCollectOptions & { query: string }): Promise<PriceObservation[]>;
}

export function parseFreshChoiceProducts(html: string): FreshChoiceProduct[];
export function toFreshChoiceObservation(
  product: FreshChoiceProduct,
  store: Store,
  options?: { observedAt?: string; origin?: string },
): PriceObservation | undefined;
