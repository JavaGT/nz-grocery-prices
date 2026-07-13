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
