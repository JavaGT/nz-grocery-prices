/**
 * Single source of truth for the public domain shapes. Both the root
 * contract (src/index.d.ts) and every retailer subpath re-export these
 * declarations — none of them may keep local copies, so they cannot drift.
 */

/** A collected store (price scope). Unknown extra fields are preserved. */
export interface Store {
  id: string;
  retailer: string;
  name?: string;
  address?: string;
  region?: string;
  [key: string]: unknown;
}

/** A collected product. Unknown extra fields are preserved. */
export interface ProductInfo {
  id: string;
  name?: string;
  brand?: string;
  gtin?: string;
  categories?: string[];
  images?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Retailer-reported promotion metadata. startsAt/endsAt bound when promo
 * cents count as active (boundaries inclusive); savePercent is advisory.
 */
export interface PromotionInfo {
  startsAt?: string;
  endsAt?: string;
  savePercent?: number;
  [key: string]: unknown;
}

/** One recorded price observation (canonical v2 domain shape). */
export interface PriceObservation {
  product: ProductInfo;
  store: Store;
  price: {
    regularCents: number;
    promoCents?: number;
    memberCents?: number;
    currency?: "NZD";
    [key: string]: unknown;
  };
  observedAt: string;
  /** Last full specials snapshot in which this offer was present. */
  lastSeenAt?: string;
  /** True/false when a full specials snapshot is available. */
  isOnSpecial?: boolean;
  promotion?: PromotionInfo;
  source: {
    retailerProductId: string;
    adapter?: string;
    url?: string;
    [key: string]: unknown;
  };
}
