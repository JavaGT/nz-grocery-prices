/**
 * Mobile API client for Foodstuffs (PAK'nSAVE / New World).
 *
 * Uses the Android-app backend at api-prod.prod.fsniwaikato.kiwi which has
 * proven more reliable than the web Algolia API for catalogue-breadth
 * collection (no intermittent tarpits observed).
 *
 * Guest auth via POST /mobile/user/login/guest, token cached until expiry
 * minus 60s margin. In-flight auth promise is shared so N concurrent first
 * calls produce exactly one login request.
 *
 * Every request goes through the injected `fetch` — the caller (crawler
 * bridge) owns pacing and retry.
 */

import { toPriceObservation } from "./foodstuffs.js";

const DEFAULT_API_ORIGIN = "https://api-prod.prod.fsniwaikato.kiwi/prod";
const DEFAULT_USER_AGENT = "PAKnSAVEApp/4.32.0 (App Version)";
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** Banner → query-param casing + URL path segment mapping. */
const BANNER_CONFIG = Object.freeze({
  PNS: { bannerQuery: "paknsave", bannerSegment: "PNS" },
  MNW: { bannerQuery: "newworld", bannerSegment: "MNW" },
});

export { toPriceObservation };

/**
 * Normalise a store-list response envelope into a bare array.
 * Accepts bare array, {stores:[...]}, or {items:[...]}.
 */
function normalizeStoreList(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.stores)) return raw.stores;
  if (raw && Array.isArray(raw.items)) return raw.items;
  return raw;
}

export class MobileFoodstuffsClient {
  #accessToken;
  #expiresAt = 0;
  #authPromise = null;
  #fetch;
  #apiOrigin;
  #userAgent;
  #banner;
  #config;

  constructor(options = {}) {
    const banner = options.banner ?? "PNS";
    const config = BANNER_CONFIG[banner];
    if (!config) {
      throw new TypeError(`Unsupported mobile banner: ${banner}`);
    }
    this.#banner = banner;
    this.#config = config;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiOrigin = (options.apiOrigin ?? DEFAULT_API_ORIGIN).replace(
      /\/+$/,
      "",
    );
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  /** Returns the canonical retailer name for the banner. */
  get retailer() {
    return this.#banner === "PNS" ? "paknsave" : "newworld";
  }

  /** Returns the banner code (PNS | MNW). */
  get banner() {
    return this.#banner;
  }

  /**
   * Authenticate as a guest, caching the token until it is within 60s of
   * expiry. Idempotent on repeated calls within the cache window.
   * Concurrent first calls share a single in-flight auth promise.
   */
  async #authenticate() {
    if (
      this.#accessToken &&
      Date.now() < this.#expiresAt - TOKEN_EXPIRY_MARGIN_MS
    ) {
      return this.#accessToken;
    }

    // Join an in-flight auth if one exists.
    if (this.#authPromise) return this.#authPromise;

    this.#authPromise = (async () => {
      const response = await this.#fetch(
        `${this.#apiOrigin}/mobile/user/login/guest`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": this.#userAgent,
          },
          body: JSON.stringify({ banner: this.#banner }),
        },
      );

      if (!response.ok) {
        throw new Error(
          `Mobile guest auth failed: ${response.status} ${response.statusText}`,
        );
      }

      const session = await response.json();
      if (!session.access_token) {
        throw new Error("Mobile guest auth returned no access token");
      }

      const expiresIn = session.expires_in;
      if (
        typeof expiresIn !== "number" ||
        !Number.isFinite(expiresIn) ||
        expiresIn <= 0
      ) {
        throw new TypeError(
          `Invalid expires_in from guest login: expected positive finite number, got ${expiresIn}`,
        );
      }

      this.#accessToken = session.access_token;
      this.#expiresAt = Date.now() + expiresIn * 1000;
      return this.#accessToken;
    })();

    try {
      return await this.#authPromise;
    } finally {
      this.#authPromise = null;
    }
  }

  /**
   * Perform an authenticated API request. Adds Authorization header and
   * user-agent; passes through all other init fields (method, body, headers).
   */
  async #request(path, init = {}) {
    const token = await this.#authenticate();
    const response = await this.#fetch(`${this.#apiOrigin}${path}`, {
      ...init,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": this.#userAgent,
        ...init.headers,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Mobile request ${path} failed: ${response.status} ${response.statusText}`,
      );
    }

    return response.json();
  }

  /**
   * List all physical stores for this banner.
   * POST /mobile/store/physical?banner=PNS|MNW  body []
   */
  async listStores() {
    const raw = await this.#request(
      `/mobile/store/physical?banner=${this.#banner}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "[]",
      },
    );
    return normalizeStoreList(raw);
  }

  /**
   * Fetch the full nested category tree for a store.
   * GET /mobile/v1/products/category?storeId=&banner=paknsave|newworld&region=NI|SI
   *
   * Returns the tree as returned by the API (array of nodes with
   * name/code/children).
   */
  async categoryTree(storeId, options = {}) {
    const region = options.region ?? "NI";
    return this.#request(
      `/mobile/v1/products/category?storeId=${encodeURIComponent(storeId)}&banner=${this.#config.bannerQuery}&region=${region}`,
      { method: "GET" },
    );
  }

  /**
   * Fetch one page of products from a category.
   * POST /mobile/ecomm-products/{PNS|MNW}/{storeId}/category
   *
   * @param {object} options
   * @param {string} options.storeId
   * @param {string} options.cat0        Required top-level category name.
   * @param {string} [options.cat1]      Optional sub-category name.
   * @param {string} [options.cat2]      Optional sub-sub-category name.
   * @param {number} [options.page]      Zero-based page index (default 0).
   * @returns {Promise<{totalHits, numberOfPages, page, products[]}>}
   */
  async categoryPage({ storeId, cat0, cat1, cat2, page = 0 }) {
    const params = new URLSearchParams({
      cat0,
      sortOrder: "Popularity",
      page: String(page),
    });
    if (cat1 !== undefined) params.set("cat1", cat1);
    if (cat2 !== undefined) params.set("cat2", cat2);

    return this.#request(
      `/mobile/ecomm-products/${this.#config.bannerSegment}/${encodeURIComponent(storeId)}/category?${params}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "[]",
      },
    );
  }
}