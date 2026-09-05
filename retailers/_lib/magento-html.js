/**
 * Classic Magento 2 server-rendered listing adapter for the retailers/
 * campaign.
 *
 * Several NZ Magento storefronts expose no usable GraphQL (empty catalog
 * scope or disabled endpoint) but render category pages as plain HTML
 * product tiles with priceBox data attributes. This module slices those
 * tiles and extracts identity/name/price via per-retailer profiles —
 * Magento themes differ enough that the tile selectors are configuration,
 * not code.
 */

import { getText } from "./http.js";
import { buildObservation, toCents } from "./observation.js";

export function decodeEntities(value = "") {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&nbsp;", " ")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

/** Slice HTML into tile strings between consecutive tile-start matches. */
export function extractTileSlices(html, tileStart) {
  const starts = [...html.matchAll(tileStart)];
  return starts.map((match, index) =>
    html.slice(match.index, starts[index + 1]?.index ?? html.length),
  );
}

/** First capture group across an ordered list of regex fallbacks. */
function firstCapture(slice, patterns) {
  for (const pattern of patterns) {
    const match = slice.match(pattern);
    if (match) return match[1];
  }
  return undefined;
}

function anchorTag(slice, className) {
  return slice.match(new RegExp(`<a\\b[^>]*class="[^"]*${className}[^"]*"[^>]*>`))?.[0];
}

function attribute(tag, name) {
  return tag?.match(new RegExp(`${name}="([^"]*)"`))?.[1];
}

/**
 * Parse one tile slice per `profile`:
 *   {
 *     tileStart: RegExp (global) marking tile boundaries,
 *     id: [regex, ...]         — required retailerProductId,
 *     name: [regex, ...]       — optional extra name fallbacks (entity-encoded ok),
 *     linkClass: string        — anchor class carrying href (+maybe title),
 *     finalPrice: [regex, ...] — current price captures ("37.99" or "$37.99"),
 *     wasPrice: [regex, ...]   — pre-discount price captures, optional,
 *     image?: boolean          — also extract the first <img src>,
 *   }
 */
export function parseMagentoTile(slice, profile) {
  const id = firstCapture(slice, profile.id);
  if (!id) return undefined;
  const link = anchorTag(slice, profile.linkClass);
  const url = attribute(link, "href") ?? firstCapture(slice, profile.url ?? []);
  const name = decodeEntities(
    firstCapture(slice, profile.name) ?? attribute(link, "title") ?? "",
  ).trim();
  const finalRaw = firstCapture(slice, profile.finalPrice);
  const wasRaw = firstCapture(slice, profile.wasPrice ?? []);
  const finalCents = toCents(finalRaw);
  const wasCents = toCents(wasRaw);
  if (!name || finalCents === undefined) return undefined;
  return {
    id,
    name,
    url,
    regularCents: wasCents !== undefined && wasCents > finalCents ? wasCents : finalCents,
    promoCents: wasCents !== undefined && wasCents > finalCents ? finalCents : undefined,
    ...(profile.image ? { image: firstCapture(slice, [/<img[^>]*\ssrc="([^"]+)"/]) } : {}),
  };
}

export function parseMagentoTiles(html, profile) {
  return extractTileSlices(html, profile.tileStart)
    .map((slice) => parseMagentoTile(slice, profile))
    .filter(Boolean);
}

/**
 * Walks configured category paths (`/category?p=N`) until a page returns
 * no *new* tile ids (repeated products across pages are fine but signal
 * the end when nothing new appears) or maxPages is reached.
 */
export class MagentoListClient {
  constructor(options = {}) {
    if (!options.origin) throw new TypeError("MagentoListClient requires origin");
    if (!options.slug) throw new TypeError("MagentoListClient requires slug");
    if (!Array.isArray(options.categories) || options.categories.length === 0) {
      throw new TypeError("MagentoListClient requires categories: [\"path\", ...]");
    }
    this.origin = options.origin.replace(/\/$/, "");
    this.slug = options.slug;
    this.scopeId = options.scopeId ?? "online";
    this.scopeName = options.scopeName ?? options.slug;
    this.categories = options.categories;
    this.profile = options.profile;
    this.pageParam = options.pageParam ?? "p";
    this.headers = { "user-agent": options.userAgent ?? undefined, ...options.headers };
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = options.timeout ?? 20000;
    this.#retry = options.retry;
  }
  #fetch;
  #timeout;
  #retry;

  getStore() {
    return {
      id: `${this.slug}:${this.scopeId}`,
      retailer: this.slug,
      scopeId: this.scopeId,
      name: this.scopeName,
      origin: this.origin,
    };
  }

  async listCategoryPage(category, page) {
    const url =
      `${this.origin}/${category.replace(/^\//, "")}` +
      `${category.includes("?") ? "&" : "?"}${this.pageParam}=${page}`;
    const html = await getText(url, {
      fetch: this.#fetch,
      headers: this.headers,
      timeout: this.#timeout,
      retry: this.#retry,
      operation: `magento ${this.slug} ${category} p${page}`,
    });
    return parseMagentoTiles(html, this.profile);
  }

  async collectProducts({ maxPages = 50, observedAt } = {}) {
    const store = this.getStore();
    const seen = new Map(); // tile id -> { tile, category label }
    for (const category of this.categories) {
      const label = decodeEntities(category.split("?")[0].split("/")[0].replace(/^\//, ""));
      for (let page = 1; page <= maxPages; page += 1) {
        let tiles;
        try {
          tiles = await this.listCategoryPage(category, page);
        } catch (error) {
          // A dead/renamed category must not abort the whole walk; page 1
          // failures skip the category entirely.
          if (page === 1) {
            console.error(`magento ${this.slug}: skipping category ${category}: ${error.message}`);
            break;
          }
          throw error;
        }
        let fresh = 0;
        for (const tile of tiles) {
          if (!seen.has(tile.id)) {
            seen.set(tile.id, { tile, label });
            fresh += 1;
          }
        }
        // Nothing new on a whole page means we've walked past the end of
        // this category's grid.
        if (fresh === 0) break;
      }
    }
    return [...seen.values()].map(({ tile, label }) =>
      buildObservation({
        slug: store.retailer,
        storeId: store.scopeId,
        storeName: store.name,
        origin: store.origin,
        retailerProductId: tile.id,
        url: tile.url,
        name: tile.name,
        image: tile.image,
        ...(label ? { categories: [label] } : {}),
        regularCents: tile.regularCents,
        promoCents: tile.promoCents,
        observedAt,
      }),
    );
  }
}
