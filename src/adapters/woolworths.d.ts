import type { PriceObservation, Store } from "../index.js";

export interface WoolworthsClientOptions {
  origin?: string;
  userAgent?: string;
  cookie?: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export interface WoolworthsCollectOptions {
  page?: number;
  size?: number;
  maxPages?: number;
  observedAt?: string;
}

export class WoolworthsClient {
  constructor(options?: WoolworthsClientOptions);
  origin: string;
  userAgent: string;
  listDeals(options?: WoolworthsCollectOptions): Promise<Record<string, any>>;
  getStore(): Promise<Store & { retailer: "woolworths"; context: Record<string, any> }>;
  collectDeals(options?: WoolworthsCollectOptions): Promise<PriceObservation[]>;
}

export function toWoolworthsObservation(
  product: Record<string, any>,
  fulfilment: Record<string, any>,
  options?: { observedAt?: string; origin?: string },
): PriceObservation | undefined;
