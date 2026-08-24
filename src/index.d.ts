/**
 * Hand-maintained public type contract for nz-grocery-prices (CORE-5).
 *
 * Declares exactly the runtime exports of ./index.js — nothing else is
 * public. Retailer client contracts live beside their implementations
 * (src/adapters/*.d.ts) behind the package's subpath exports. The agent-feed
 * shape (AgentFeed) is an intentionally stable contract.
 *
 * Kept honest by test/types-surface.test.js: the runtime export-name set,
 * these declarations, and consumer fixtures must all agree.
 */

// ---- Domain data shapes ----

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

/** Which candidate price an evaluation selected. */
export type EffectivePriceKind = "regular" | "promo" | "member";

// ---- Query shapes ----

/** Repository/history filter: predicate match plus inclusive observedAt window. */
export interface ObservationQuery {
  productId?: string;
  storeId?: string;
  retailer?: string;
  from?: string;
  to?: string;
}

/** Tuning knobs shared by the sale analytics. */
export interface SaleTuning {
  /** Restrict to these product IDs. */
  productIds?: string[];
  /** How recent the newest observation must be, in days (default 7). */
  freshWithinDays?: number;
  /** "member" admits member-only cents (default "public"). */
  pricePolicy?: "public" | "member";
}

/** Options for history-backed sale detection. */
export interface HistorySaleOptions extends SaleTuning {
  /** Baseline look-back window in days (default 90). */
  baselineDays?: number;
  /** Minimum baseline samples required (default 2). */
  minSamples?: number;
  /** Smallest drop from baseline to report, in percent (default 0). */
  minDropPercent?: number;
  /** Report strict new all-time lows regardless of drop size (default true). */
  includeAllTimeLows?: boolean;
}

/**
 * Query for the PriceArchive sale methods: same tuning knobs plus optional
 * scoping. `at` defaults to the archive's injected clock when omitted.
 */
export interface ArchiveSaleQuery extends HistorySaleOptions {
  at?: string;
  retailer?: string;
  storeId?: string;
}

// ---- Results ----

/** A history-backed price drop for one offer. */
export interface Sale {
  product: ProductInfo;
  store: Store;
  current: { cents: number; kind: EffectivePriceKind; observedAt: string };
  baseline: { averageCents: number; sampleCount: number; days: number };
  dropPercent: number;
  previousLowCents: number;
  isAllTimeLow: boolean;
  promotion?: PromotionInfo;
}

/** A currently-advertised promotion for one offer. */
export interface OngoingSale {
  product: ProductInfo;
  store: Store;
  current: { cents: number; kind: EffectivePriceKind; observedAt: string };
  regularCents: number;
  savePercent?: number;
  promotion: PromotionInfo;
}

/** One effective-price point of a buildPriceSeries series. */
export interface PriceSeriesPoint {
  observedAt: string;
  cents: number;
  kind: EffectivePriceKind;
}

/** Per-offer effective-price history, sorted ascending by observedAt. */
export interface PriceSeries {
  productId: string;
  storeId: string;
  points: PriceSeriesPoint[];
}

/** Stable agent-feed entry: a history-backed sale. */
export interface AgentFeedHistorySale {
  productId: string;
  productName: string;
  brand?: string;
  storeId: string;
  storeName: string;
  retailer: string;
  currentCents: number;
  priceKind: EffectivePriceKind;
  baselineAverageCents: number;
  baselineSampleCount: number;
  dropPercent: number;
  isAllTimeLow: boolean;
  observedAt: string;
  promotion?: PromotionInfo;
}

/** Stable agent-feed entry: a currently-advertised promotion. */
export interface AgentFeedOngoingSale {
  productId: string;
  productName: string;
  brand?: string;
  gtin?: string;
  storeId: string;
  storeName: string;
  retailer: string;
  currentCents: number;
  regularCents: number;
  priceKind: EffectivePriceKind;
  savePercent?: number;
  observedAt: string;
  promotion: PromotionInfo;
}

/**
 * The agent-oriented feed. Deliberately two separate lists — advertised
 * promotions (no history required) and history-backed drops — so consumers
 * never guess which evidence backs an entry.
 */
export interface AgentFeed {
  generatedAt: string;
  currency: "NZD";
  ongoingSales: AgentFeedOngoingSale[];
  sales: AgentFeedHistorySale[];
}

// ---- Repositories ----

/** Options for appending observations. */
export interface AppendOptions {
  /** Listing scope for snapshot records (e.g. "specials"). */
  snapshotScope?: string;
}

/** A content revision of one product, oldest first within productHistory. */
export interface ProductRevision {
  hash: string;
  observedAt: string;
  product: ProductInfo;
}

/**
 * Storage seam for observations. PriceArchive depends on this interface, so
 * alternative backends can replace the supplied implementations.
 */
export interface ObservationRepository {
  append(
    observations: readonly PriceObservation[],
    options?: AppendOptions,
  ): Promise<number>;
  query(query?: ObservationQuery): Promise<PriceObservation[]>;
  productHistory?(productId: string): Promise<ProductRevision[]>;
}

/** Hash mismatch found while loading an archive (non-fatal damage report). */
export interface ArchiveLoadDefect {
  line: number;
  type: "product" | "store" | "offer";
  id: string;
  stored: string;
  recomputed: string;
}

/** Summary of indexed archive state. Null dates when empty. */
export interface ArchiveStats {
  records: { product: number; store: number; offer: number; snapshot: number };
  retailers: string[];
  firstObservedAt: string | null;
  lastObservedAt: string | null;
}

/** In-memory repository: deduplicates, keeps insertion order, holds no files. */
export declare class MemoryObservationRepository implements ObservationRepository {
  append(
    observations: readonly PriceObservation[],
    options?: AppendOptions,
  ): Promise<number>;
  query(query?: ObservationQuery): Promise<PriceObservation[]>;
  productHistory(productId: string): Promise<ProductRevision[]>;
}

/**
 * Durable append-only JSONL archive: cross-process locking, fsynced appends,
 * atomic compaction, tail-tolerant loading, v1-record refusal.
 */
export declare class JsonlObservationRepository implements ObservationRepository {
  constructor(filePath?: string);
  readonly filePath: string;
  append(
    observations: readonly PriceObservation[],
    options?: AppendOptions,
  ): Promise<number>;
  query(query?: ObservationQuery): Promise<PriceObservation[]>;
  /** Deduplicate repeated revisions/snapshots via atomic file replacement. */
  compact(): Promise<{ records: number; file: string }>;
  productHistory(productId: string): Promise<ProductRevision[]>;
  /** Record counts by type, distinct retailers, and the observedAt span. */
  stats(): Promise<ArchiveStats>;
  /** Hash mismatches from the most recent load (empty when undamaged). */
  getLoadDefects(): ArchiveLoadDefect[];
}

// ---- Facade ----

/**
 * Repository-backed facade adding analytics queries. The optional clock
 * (default wall clock) is the ONLY time source: queries omitting `at`
 * derive it here, keeping the analytics functions pure.
 */
export declare class PriceArchive {
  constructor(
    repository: ObservationRepository,
    options?: { clock?: () => Date },
  );
  readonly repository: ObservationRepository;
  record(
    observations: readonly PriceObservation[],
    options?: AppendOptions,
  ): Promise<number>;
  history(query?: ObservationQuery): Promise<PriceObservation[]>;
  productHistory(productId: string): Promise<ProductRevision[]>;
  findSales(query?: ArchiveSaleQuery): Promise<Sale[]>;
  ongoingSales(query?: ArchiveSaleQuery): Promise<OngoingSale[]>;
  agentFeed(query?: ArchiveSaleQuery): Promise<AgentFeed>;
}

// ---- Pure functions ----

/**
 * Validates one observation, throwing a TypeError naming every problem
 * (field paths joined by "; "); returns the input unchanged when valid.
 */
export function parseObservation<Observation extends PriceObservation>(
  observation: Observation,
): Observation;

/**
 * History-backed sale detection across all offers in `observations`.
 * Requires an explicit `at` (ISO string) — evaluation is deterministic,
 * never wall-clock. Baseline samples evaluate at their own observedAt.
 */
export function calculateSales(
  observations: readonly PriceObservation[],
  query: HistorySaleOptions & { at: string },
): Sale[];

/**
 * Currently-advertised promotions: latest observation per offer, still
 * listed, promotion active at `at`. Requires an explicit `at` (ISO string).
 */
export function calculateOngoingSales(
  observations: readonly PriceObservation[],
  query: SaleTuning & { at: string; retailer?: string; storeId?: string },
): OngoingSale[];

/**
 * One series per productId+storeId pair, points ascending by observedAt,
 * each priced with promotion activity evaluated at that point. Series sort
 * by productId then storeId; empty input yields [].
 */
export function buildPriceSeries(
  observations: readonly PriceObservation[],
  options?: { pricePolicy?: "public" | "member" },
): PriceSeries[];

/** Renders sales into the stable agent-feed shape. */
export function toAgentFeed(
  sales: readonly Sale[],
  generatedAt: string,
  ongoingSales?: readonly OngoingSale[],
): AgentFeed;
