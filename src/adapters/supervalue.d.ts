import type { PriceObservation, Store } from "../index.js";
import type { FreshChoiceProduct } from "./freshchoice.js";

export interface SuperValueClientOptions {
  origin?: string;
  storeSlug?: string;
  storeName?: string;
  storeAddress?: string;
  storeListUrl?: string;
  chooserOrigin?: string;
  userAgent?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export interface SuperValueCollectOptions {
  page?: number;
  maxPages?: number;
  query?: string;
  observedAt?: string;
}

export interface SuperValueStoreLink {
  chooserId: string;
  retailer: "supervalue";
  name: string;
  address?: string;
}

export interface SuperValueStore extends SuperValueStoreLink {
  id: string;
  slug: string;
  origin: string;
}

export function parseSuperValueStoreLinks(html: string): SuperValueStoreLink[];
export function parseSuperValueProducts(html: string): FreshChoiceProduct[];
export function toSuperValueObservation(
  product: FreshChoiceProduct,
  store: Store,
  options?: { observedAt?: string; origin?: string },
): PriceObservation | undefined;

export class SuperValueClient {
  constructor(options?: SuperValueClientOptions);
  origin: string;
  storeSlug: string;
  storeName: string;
  storeAddress?: string;
  storeListUrl: string;
  chooserOrigin: string;
  userAgent: string;
  getStore(): Store & { retailer: "supervalue"; origin: string };
  listStores(): Promise<SuperValueStore[]>;
  listDeals(options?: SuperValueCollectOptions): Promise<string>;
  searchProducts(options?: SuperValueCollectOptions): Promise<string>;
  collectDeals(options?: SuperValueCollectOptions): Promise<PriceObservation[]>;
  collectProducts(options?: SuperValueCollectOptions): Promise<PriceObservation[]>;
}
