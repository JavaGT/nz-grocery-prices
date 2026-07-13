export interface Store {
  id: string;
  name: string;
  banner?: string;
  address?: string;
  region?: string;
  [key: string]: unknown;
}

export interface PriceObservation {
  product: {
    id: string;
    name: string;
    brand?: string;
    gtin?: string;
    categories?: string[];
    images?: Record<string, string>;
  };
  store: {
    id: string;
    retailer: string;
    name: string;
    address?: string;
    region?: string;
  };
  price: {
    currency: "NZD";
    regularCents: number;
    promoCents?: number;
    memberCents?: number;
    comparative?: Record<string, unknown>;
  };
  promotion?: Record<string, unknown>;
  observedAt: string;
  /** Last full specials snapshot in which this offer was present. */
  lastSeenAt?: string;
  /** True/false when a full specials snapshot is available; absent for legacy data. */
  isOnSpecial?: boolean;
  source: {
    retailerProductId: string;
    adapter: string;
    url: string;
  };
}

export interface ObservationQuery {
  productId?: string;
  storeId?: string;
  retailer?: string;
  from?: string;
  to?: string;
}

export interface SaleQuery {
  at?: string;
  retailer?: string;
  storeId?: string;
  productIds?: string[];
  freshWithinDays?: number;
  baselineDays?: number;
  minSamples?: number;
  minDropPercent?: number;
  includeAllTimeLows?: boolean;
  pricePolicy?: "public" | "member";
}

export interface Sale {
  product: PriceObservation["product"];
  store: PriceObservation["store"];
  current: { cents: number; kind: "regular" | "promo" | "member"; observedAt: string };
  baseline: { averageCents: number; sampleCount: number; days: number };
  dropPercent: number;
  previousLowCents: number;
  isAllTimeLow: boolean;
  promotion?: Record<string, unknown>;
}

export interface OngoingSale {
  product: PriceObservation["product"];
  store: PriceObservation["store"];
  current: { cents: number; kind: "regular" | "promo" | "member"; observedAt: string };
  regularCents: number;
  savePercent?: number;
  promotion: Record<string, unknown>;
}

export interface AgentFeedSale {
  productId: string;
  productName: string;
  brand?: string;
  gtin?: string;
  storeId: string;
  storeName: string;
  retailer: string;
  currentCents: number;
  priceKind: "regular" | "promo" | "member";
  observedAt: string;
  promotion?: Record<string, unknown>;
  regularCents?: number;
  savePercent?: number;
  baselineAverageCents?: number;
  baselineSampleCount?: number;
  dropPercent?: number;
  isAllTimeLow?: boolean;
}

export interface AgentFeed {
  generatedAt: string;
  currency: "NZD";
  ongoingSales: AgentFeedSale[];
  sales: AgentFeedSale[];
}

export interface ObservationRepository {
  append(observations: PriceObservation[], options?: { snapshotScope?: string }): Promise<number>;
  query(query?: ObservationQuery): Promise<PriceObservation[]>;
  productHistory?(productId: string): Promise<ProductRevision[]>;
}

export interface ProductRevision {
  hash: string;
  observedAt: string;
  product: PriceObservation["product"];
}

export class MemoryObservationRepository implements ObservationRepository {
  append(observations: PriceObservation[], options?: { snapshotScope?: string }): Promise<number>;
  query(query?: ObservationQuery): Promise<PriceObservation[]>;
  productHistory(productId: string): Promise<ProductRevision[]>;
}

export class JsonlObservationRepository implements ObservationRepository {
  constructor(filePath?: string);
  filePath: string;
  append(observations: PriceObservation[], options?: { snapshotScope?: string }): Promise<number>;
  query(query?: ObservationQuery): Promise<PriceObservation[]>;
  compact(): Promise<{ records: number; file: string }>;
  productHistory(productId: string): Promise<ProductRevision[]>;
}

export class PriceArchive {
  constructor(repository: ObservationRepository);
  repository: ObservationRepository;
  record(observations: PriceObservation[], options?: { snapshotScope?: string }): Promise<number>;
  history(query?: ObservationQuery): Promise<PriceObservation[]>;
  productHistory(productId: string): Promise<ProductRevision[]>;
  findSales(query?: SaleQuery): Promise<Sale[]>;
  ongoingSales(query?: SaleQuery): Promise<OngoingSale[]>;
  agentFeed(query?: SaleQuery): Promise<AgentFeed>;
}

export function calculateSales(observations: PriceObservation[], query?: SaleQuery): Sale[];
export function calculateOngoingSales(
  observations: PriceObservation[],
  query?: SaleQuery,
): OngoingSale[];
export function toAgentFeed(
  sales: Sale[],
  generatedAt: string,
  ongoingSales?: OngoingSale[],
): AgentFeed;

export interface FoodstuffsClientOptions {
  banner?: "paknsave" | "newworld";
  webOrigin?: string;
  apiOrigin?: string;
  userAgent?: string;
  fingerprint?: string;
  fetch?: typeof fetch;
}

export interface CollectOptions {
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
  banner: string;
  retailer: string;
  apiBanner: string;
  webOrigin: string;
  apiOrigin: string;
  userAgent: string;
  listStores(options?: { query?: string }): Promise<Store[]>;
  getStore(storeId: string): Promise<Store>;
  searchProducts(options: CollectOptions): Promise<Record<string, any>>;
  listDeals(options: CollectOptions): Promise<Record<string, any>>;
  listMobileDeals(options: CollectOptions): Promise<Record<string, any>>;
  collectProducts(options: CollectOptions): Promise<PriceObservation[]>;
  collectDeals(options: CollectOptions): Promise<PriceObservation[]>;
}

export class PaknsaveClient extends FoodstuffsClient {}
export class NewWorldClient extends FoodstuffsClient {}

export function toPriceObservation(
  product: Record<string, any>,
  store: Store,
  options?: { retailer?: string; observedAt?: string },
): PriceObservation | undefined;

export {
  WoolworthsClient,
  toWoolworthsObservation,
} from "./adapters/woolworths.js";
export {
  FreshChoiceClient,
  parseFreshChoiceProducts,
  toFreshChoiceObservation,
} from "./adapters/freshchoice.js";
export {
  WarehouseClient,
  parseWarehouseProducts,
  toWarehouseObservation,
} from "./adapters/warehouse.js";
