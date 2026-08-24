/**
 * Public contract for nz-grocery-prices/foodstuffs — PAK'nSAVE and New
 * World share this Foodstuffs client. Hand-maintained like src/index.d.ts.
 */

/** Local copy of the public domain shapes (see src/index.d.ts). */
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

export interface FoodstuffsClientOptions {
  banner?: "paknsave" | "newworld";
  webOrigin?: string;
  apiOrigin?: string;
  userAgent?: string;
  fingerprint?: string;
  fetch?: typeof fetch;
}

export interface FoodstuffsCollectOptions {
  storeId: string;
  store?: Store;
  page?: number;
  maxPages?: number;
  hitsPerPage?: number;
  query?: string;
  region?: string;
  onPromotion?: boolean;
  observedAt?: string;
}

export class FoodstuffsClient {
  constructor(options?: FoodstuffsClientOptions);
  banner: "paknsave" | "newworld";
  retailer: "paknsave" | "newworld";
  apiBanner: string;
  webOrigin: string;
  apiOrigin: string;
  userAgent: string;
  listStores(options?: { query?: string }): Promise<Store[]>;
  getStore(storeId: string): Promise<Store>;
  searchProducts(options: FoodstuffsCollectOptions): Promise<Record<string, any>>;
  listDeals(options: FoodstuffsCollectOptions): Promise<Record<string, any>>;
  listMobileDeals(options: FoodstuffsCollectOptions): Promise<Record<string, any>>;
  collectProducts(options: FoodstuffsCollectOptions): Promise<PriceObservation[]>;
  collectDeals(options: FoodstuffsCollectOptions): Promise<PriceObservation[]>;
}

export class PaknsaveClient extends FoodstuffsClient {}
export class NewWorldClient extends FoodstuffsClient {}

export function toPriceObservation(
  product: Record<string, any>,
  store: Store,
  options?: { retailer?: "paknsave" | "newworld"; observedAt?: string },
): PriceObservation | undefined;
