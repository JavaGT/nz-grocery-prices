/**
 * Public contract for nz-grocery-prices/foodstuffs — PAK'nSAVE and New
 * World share this Foodstuffs client. Hand-maintained like src/index.d.ts.
 */

/** Local copy of the public domain shapes (see src/index.d.ts). */
/**
 * Domain shapes come from the SHARED public contract —
 * src/domain/observation.d.ts is the single source; importing it here
 * (instead of copying) is what keeps the copies from drifting.
 */
import type { PriceObservation, Store } from "../domain/observation.js";
export type { PriceObservation, Store };

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
