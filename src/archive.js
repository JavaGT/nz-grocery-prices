import { calculateOngoingSales, calculateSales, toAgentFeed } from "./analytics.js";

/**
 * Facade over an observation repository adding analytics queries.
 *
 * The optional `clock` (default wall clock) is the ONLY time source here:
 * when a query omits `at`, the archive derives it from this clock and passes
 * it down explicitly. Analytics functions stay pure/deterministic — they
 * never read time themselves.
 */
export class PriceArchive {
  constructor(repository, { clock = () => new Date() } = {}) {
    this.repository = repository;
    this.clock = clock;
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

  async findSales(query = {}) {
    const at = query.at ?? this.clock().toISOString();
    const observations = await this.repository.query({
      to: at,
      retailer: query.retailer,
      storeId: query.storeId,
    });
    return calculateSales(observations, { ...query, at });
  }

  async ongoingSales(query = {}) {
    const at = query.at ?? this.clock().toISOString();
    const observations = await this.repository.query({
      to: at,
      retailer: query.retailer,
      storeId: query.storeId,
    });
    return calculateOngoingSales(observations, { ...query, at });
  }

  async agentFeed(query = {}) {
    const generatedAt = query.at ?? this.clock().toISOString();
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
