import type { PriceObservation, Store } from "../index.js";

export interface WarehouseClientOptions {
  origin?: string;
  category?: string;
  userAgent?: string;
  scopeId?: string;
  scopeName?: string;
  region?: string;
  headers?: Record<string, string>;
  transport?: "curl" | "fetch";
  curlPath?: string;
  fetch?: typeof fetch;
}

export interface WarehouseCollectOptions {
  page?: number;
  size?: number;
  maxPages?: number;
  query?: string;
  observedAt?: string;
  includeMarketplace?: boolean;
}

export class WarehouseClient {
  constructor(options?: WarehouseClientOptions);
  origin: string;
  category: string;
  userAgent: string;
  scopeId: string;
  scopeName: string;
  region?: string;
  curlPath: string;
  getStore(): Store & { retailer: "warehouse"; origin: string };
  listDeals(options?: WarehouseCollectOptions): Promise<string>;
  searchProducts(options: WarehouseCollectOptions & { query: string }): Promise<string>;
  collectDeals(options?: WarehouseCollectOptions): Promise<PriceObservation[]>;
  collectProducts(options: WarehouseCollectOptions & { query: string }): Promise<PriceObservation[]>;
}

export function parseWarehouseProducts(html: string): Record<string, any>[];
export function toWarehouseObservation(
  product: Record<string, any>,
  store: Store,
  options?: { observedAt?: string; origin?: string },
): PriceObservation | undefined;
