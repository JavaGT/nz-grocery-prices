/**
 * BREADTH-2 — FreshChoice full-catalogue browsing client.
 *
 * Lightweight transport wrapper for breadth collection. Mirrors
 * MobileFoodstuffsClient's #pace pattern: pacing lives here, not in a
 * transport wrapper (the pilot proved wrapper-layer hangs against other
 * backends while bare sequential fetches flowed fine).
 *
 * Reuses parseFreshChoiceProducts, pageCount, and toFreshChoiceObservation
 * from the existing adapter. Only adds sitemap parsing + paced HTML fetch.
 */

import { parseFreshChoiceProducts, pageCount, toFreshChoiceObservation } from "./freshchoice.js";
import { readBodyText } from "./fetch-with-retry.js";

const DEFAULT_USER_AGENT = "nz-grocery-prices/0.1";
const DEFAULT_TIMEOUT = 15000;

/**
 * Parse /category/* URLs from a storefront's sitemap.xml.
 * Extracts every <loc> entry whose path includes "/category/" and returns
 * unique, sorted paths relative to the store origin.
 */
export function parseSitemapCategoryUrls(xml) {
  if (typeof xml !== "string" || !xml) return [];
  const seen = new Set();
  const locRegex = /<loc>([^<]+)<\/loc>/gi;
  let match;
  while ((match = locRegex.exec(xml)) !== null) {
    const url = match[1].trim();
    // Only /category/* paths are listing pages; /lines are PDPs, skip.
    if (url.includes("/category/")) {
      seen.add(url);
    }
  }
  return [...seen].sort();
}

export const BREAKER_THRESHOLD = 5;

const ORIGIN_HOST_APEX = "freshchoice.co.nz";
const ORIGIN_HOST_SUFFIX = ".freshchoice.co.nz";

/**
 * Pin fetches to FreshChoice web properties. Store origins come from the
 * store-list API — untrusted input — and the breadth client would
 * otherwise GET whatever host an API response names. Returns the normalized
 * origin (no trailing slash); throws on anything outside the apex/suffix.
 */
export function assertFreshChoiceOrigin(origin) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`FreshChoice origin is not a valid URL: ${origin}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`FreshChoice origin must be https: ${origin}`);
  }
  const { host } = parsed;
  if (host !== ORIGIN_HOST_APEX && !host.endsWith(ORIGIN_HOST_SUFFIX)) {
    throw new Error(
      `FreshChoice origin ${origin} is outside *.freshchoice.co.nz — ` +
        "refusing to fetch hosts the store-list API named",
    );
  }
  return parsed.origin;
}

/**
 * Lightweight browsing client for FreshChoice breadth collection.
 * One instance per crawl run; pacing (delayMs) is applied INSIDE this
 * client rather than in a transport wrapper.
 */
export class FreshChoiceBreadthClient {
  #fetch;
  #delayMs;
  #lastCompletedAt = 0;
  #userAgent;
  #timeout;

  /** @type {number} Consecutive failures since last success. */
  consecutiveFailures = 0;
  /** @type {boolean} Circuit opened (>= BREAKER_THRESHOLD consecutive failures). */
  circuitOpened = false;

  constructor(options = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#delayMs = options.delayMs ?? 0;
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#timeout = options.timeout ?? DEFAULT_TIMEOUT;
  }

  /** Enforce minimum gap since last completed request. */
  async #pace() {
    if (this.#delayMs <= 0) return;
    const gap = Date.now() - this.#lastCompletedAt;
    if (gap < this.#delayMs) {
      await new Promise((resolve) => setTimeout(resolve, this.#delayMs - gap));
    }
  }

  #recordSuccess() {
    this.consecutiveFailures = 0;
    this.#lastCompletedAt = Date.now();
  }

  #recordFailure() {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= BREAKER_THRESHOLD) {
      this.circuitOpened = true;
    }
  }

  /**
   * Fetch and parse a storefront's sitemap.xml into category URLs.
   * @param {string} origin — e.g. "https://queenstown.store.freshchoice.co.nz"
   * @returns {Promise<string[]>} sorted, unique /category/* URLs
   */
  async fetchSitemap(origin) {
    await this.#pace();
    const base = assertFreshChoiceOrigin(origin);
    const url = `${base}/sitemap.xml`;
    const response = await this.#fetch(url, {
      headers: {
        accept: "application/xml,text/xml",
        "user-agent": this.#userAgent,
      },
      signal: AbortSignal.timeout(this.#timeout),
    });
    if (!response.ok) {
      this.#recordFailure();
      throw new Error(
        `FreshChoice sitemap fetch failed (${response.status}): ${url}`,
      );
    }
    const xml = await readBodyText(response, { label: "FreshChoice sitemap" });
    this.#recordSuccess();
    return parseSitemapCategoryUrls(xml);
  }

  /**
   * Fetch one page of a category listing.
   * @param {string} origin — store origin
   * @param {string} categoryPath — e.g. "/category/bakery"
   * @param {number} page — zero-based; page 0 fetches the root URL
   * @returns {Promise<string>} HTML text
   */
  async fetchCategoryPage(origin, categoryPath, page) {
    await this.#pace();
    const base = assertFreshChoiceOrigin(origin);
    const url = page > 0 ? `${base}${categoryPath}?page=${page}` : `${base}${categoryPath}`;
    const response = await this.#fetch(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": this.#userAgent,
      },
      signal: AbortSignal.timeout(this.#timeout),
    });
    if (!response.ok) {
      this.#recordFailure();
      throw new Error(
        `FreshChoice category page fetch failed (${response.status}): ${url}`,
      );
    }
    const html = await readBodyText(response, { label: "FreshChoice category page" });
    this.#recordSuccess();
    return html;
  }
}