/**
 * Public contract for nz-grocery-prices/woolworths. Hand-maintained like
 * src/index.d.ts; domain shapes are local copies (see that file).
 */
export interface Store {
  id: string;
  retailer: string;
  name?: string;
  address?: string;
  region?: string;
  [key: string]: unknown;
}

export interface PriceObservation {
  product: Record<string, unknown> & { id: string };
  store: Store;
  price: {
    regularCents: number;
    promoCents?: number;
    memberCents?: number;
    [key: string]: unknown;
  };
  observedAt: string;
  lastSeenAt?: string;
  isOnSpecial?: boolean;
  promotion?: Record<string, unknown>;
  source: {
    retailerProductId: string;
    [key: string]: unknown;
  };
}

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
