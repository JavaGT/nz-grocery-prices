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
import { parseJsonResponse } from "./fetch-with-retry.js";

const DEFAULT_API_ORIGIN = "https://api-prod.prod.fsniwaikato.kiwi/prod";
const DEFAULT_USER_AGENT = "PAKnSAVEApp/4.32.0 (App Version)";
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
/** Extra attempts for network errors / 5xx on top of the first try. */
const RETRYABLE_ATTEMPTS = 2;
/** Backoff between retries, scaled by attempt number. */
const RETRY_BACKOFF_MS = 3000;

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
  #timeout;
  #delayMs;
  #retryBackoffMs;
  #lastCompletedAt = 0;
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
    this.#timeout = options.timeout ?? 20000;
    // Politeness floor between COMPLETED requests on this client instance.
    // Pacing lives here rather than in a transport wrapper because the
    // pilot proved every wrapper-layer (crawler host slots) hung against
    // this backend while bare sequential fetches flowed fine.
    this.#delayMs = options.delayMs ?? 0;
    // Backoff between retryable attempts (5xx / network blips). Injectable
    // so tests exercise the exact retry semantics without real 3-6s sleeps.
    this.#retryBackoffMs = options.retryBackoffMs ?? RETRY_BACKOFF_MS;
  }

  /** Enforce the minimum gap since the last completed request. */
  async #pace() {
    if (this.#delayMs <= 0) return;
    const gap = Date.now() - this.#lastCompletedAt;
    if (gap < this.#delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.#delayMs - gap));
    }
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
      await this.#pace();
      const response = await this.#fetch(
        `${this.#apiOrigin}/mobile/user/login/guest`,
        {
          method: "POST",
          signal: AbortSignal.timeout(this.#timeout),
          headers: {
            "content-type": "application/json",
            "user-agent": this.#userAgent,
          },
          body: JSON.stringify({ banner: this.#banner }),
        },
      );
      this.#lastCompletedAt = Date.now();

      if (!response.ok) {
        throw new Error(
          `Mobile guest auth failed: ${response.status} ${response.statusText}`,
        );
      }

      const session = await parseJsonResponse(response, "Mobile guest auth");
      if (typeof session !== "object" || session === null) {
        // `session.access_token` on null would crash with an unrelated
        // TypeError; name the operation instead.
        throw new Error("Mobile guest auth returned a non-object payload");
      }
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
    // Bounded retries: ONE owner (this client — nothing wraps mobile
    // fetches). Transient connect blips and 5xx must not kill a nightly
    // pass; pacing applies between attempts. Timeout ceiling still caps
    // each attempt so silent hangs become counted failures.
    const maxAttempts = 1 + RETRYABLE_ATTEMPTS;
    let lastError;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (attempt > 0) await this.#pace();
      try {
        const response = await this.#fetch(`${this.#apiOrigin}${path}`, {
          ...init,
          signal: AbortSignal.timeout(this.#timeout),
          headers: {
            accept: "application/json",
            authorization: `Bearer ${token}`,
            "user-agent": this.#userAgent,
            ...init.headers,
          },
        });
        this.#lastCompletedAt = Date.now();
        if (
          response.status >= 500 &&
          response.status <= 599 &&
          attempt < maxAttempts - 1
        ) {
          lastError = new Error(`Mobile request ${path} failed: 5xx`);
          await new Promise((resolve) =>
            setTimeout(resolve, this.#retryBackoffMs * (attempt + 1)),
          );
          continue;
        }
        if (!response.ok) {
          throw new Error(
            `Mobile request ${path} failed: ${response.status} ${response.statusText}`,
          );
        }
        return parseJsonResponse(response, `Mobile request ${path}`);
      } catch (error) {
        this.#lastCompletedAt = Date.now();
        lastError = error;
        if (attempt >= maxAttempts - 1) throw error;
        await new Promise((resolve) =>
          setTimeout(resolve, this.#retryBackoffMs * (attempt + 1)),
        );
      }
    }
    throw lastError ?? new Error(`Mobile request ${path} failed`);
  }

  /**
   * List all physical stores for this banner.
   * GET /mobile/store/physical?banner=PNS|MNW — live-verified 200; the
   * server answers POST with 405 allowedMethods:["GET"].
   * Envelope: {stores:[…]} (normalized by normalizeStoreList).
   */
  async listStores() {
    const raw = await this.#request(
      `/mobile/store/physical?banner=${this.#banner}`,
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