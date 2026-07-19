import { calculateOngoingSales, calculateSales, toAgentFeed } from "./analytics.js";

export class PriceArchive {
  constructor(repository) {
    this.repository = repository;
  }

  async record(observations, options = {}) {
    return this.repository.append(observations, options);
  }

  async history(query = {}) {
    return this.repository.query(query);
  }

  async productHistory(productId) {
    if (typeof this.repository.productHistory === "function") {
      return this.repository.productHistory(productId);
    }
    return [];
  }

  /**
   * True when the backing repository exposes the flat SQL read model, so the
   * site can serve /stats, /stores and /products with indexed aggregates
   * instead of materialising the whole archive. JSONL archives return false.
   */
  get fastReads() {
    return typeof this.repository.productListings === "function";
  }

  async summary() {
    return this.repository.summary();
  }

  async storeList() {
    return this.repository.storeList();
  }

  async productListings(query = {}) {
    return this.repository.productListings(query);
  }

  async productImageMap() {
    return this.repository.productImageMap();
  }

  /**
   * Deal feed computed with bounded SQL instead of materialising every offer.
   * Advertised specials come from a top-N SQL query; history-backed sales run
   * calculateSales over just the (few) offers that have >= 2 revisions. Same
   * output shape as agentFeed(). Falls back to agentFeed for repositories
   * without the fast read model (e.g. JSONL).
   */
  async dealsFeed(query = {}) {
    if (typeof this.repository.advertisedSpecials !== "function") {
      return this.agentFeed(query);
    }
    const generatedAt = query.at ?? new Date().toISOString();
    const normalizedQuery = { ...query, at: generatedAt };
    // Pre-materialized deals table — data is already in the flat response shape.
    if (typeof this.repository.deals === "function") {
      const [sales, ongoingSales] = await Promise.all([
        this.repository.deals(normalizedQuery),
        this.repository.advertisedSpecials(normalizedQuery),
      ]);
      return { generatedAt, currency: "NZD", sales: sales || [], ongoingSales: ongoingSales || [] };
    }
    // Fallback: request-time calculateSales + toAgentFeed (JSONL archives).
    const ongoingSales = this.repository.advertisedSpecials(normalizedQuery);
    const sales = calculateSales(this.repository.multiRevisionObservations(), normalizedQuery);
    const feed = toAgentFeed(sales, generatedAt, []);
    feed.ongoingSales = ongoingSales;
    return feed;
  }

  rebuildListings() {
    if (typeof this.repository.rebuildListings === "function") {
      return this.repository.rebuildListings();
    }
    return 0;
  }

  async findSales(query = {}) {
    const observations = await this.repository.query({
      to: query.at,
      retailer: query.retailer,
      storeId: query.storeId,
    });
    return calculateSales(observations, query);
  }

  async ongoingSales(query = {}) {
    const observations = await this.repository.query({
      to: query.at,
      retailer: query.retailer,
      storeId: query.storeId,
    });
    return calculateOngoingSales(observations, query);
  }

  async agentFeed(query = {}) {
    const generatedAt = query.at ?? new Date().toISOString();
    const observations = await this.repository.query({
      to: generatedAt,
      retailer: query.retailer,
      storeId: query.storeId,
    });
    const normalizedQuery = { ...query, at: generatedAt };
    const sales = calculateSales(observations, normalizedQuery);
    const ongoingSales = calculateOngoingSales(observations, normalizedQuery);
    return toAgentFeed(sales, generatedAt, ongoingSales);
  }
}
