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
// Single source of truth lives in src/domain/observation.d.ts; the root
// re-exports it so adapters and consumers share one declaration.

import type {
  PriceObservation,
  ProductInfo,
  PromotionInfo,
  Store,
} from "./domain/observation.js";

export type { PriceObservation, ProductInfo, PromotionInfo, Store };

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
  /** Absent when the source observation's product had no name. */
  productName?: string;
  brand?: string;
  storeId: string;
  /** Absent when the source observation's store had no name. */
  storeName?: string;
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
  /** Absent when the source observation's product had no name. */
  productName?: string;
  brand?: string;
  gtin?: string;
  storeId: string;
  /** Absent when the source observation's store had no name. */
  storeName?: string;
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
 *
 * append() resolves to an IMPLEMENTATION-DEFINED count: the JSONL repository
 * returns archive records written (product/store/offer revisions, so one
 * observation may count several), while the in-memory repository returns
 * observations stored. Treat the number as opaque progress, never as an
 * observation count.
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
  /** Returns the number of OBSERVATIONS stored (dedup may shrink it). */
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
  /** Returns the number of ARCHIVE RECORDS written (revisions, not observations). */
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
  /** The injected time source (default wall clock); queries omitting `at` use it. */
  readonly clock: () => Date;
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
