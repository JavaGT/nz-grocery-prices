/**
 * Public contract for nz-grocery-prices/woolworths. Hand-maintained like
 * src/index.d.ts; domain shapes are local copies (see that file).
 */
/**
 * Domain shapes come from the SHARED public contract —
 * src/domain/observation.d.ts is the single source; importing it here
 * (instead of copying) is what keeps the copies from drifting.
 */
import type { PriceObservation, Store } from "../domain/observation.js";
export type { PriceObservation, Store };

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
