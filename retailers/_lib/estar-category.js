/**
 * eStar-style "window.category" JSON adapter for the retailers/ campaign.
 *
 * Several NZ storefronts (Liquorland, Baby Factory, Whitcoulls) embed the
 * whole category payload as `window.category = {...}` in a script tag:
 * items[] with productid/description/variants[].unitprice and friends.
 * Category pages paginate server-side (?p=N); pass pageParam: "p" to walk
 * past page 1 (verified live on liquorland, baby-factory, whitcoulls,
 * glassons, postie, number-one-shoes).
 */

import { BROWSER_UA, getText } from "./http.js";
import { buildObservation, toCents } from "./observation.js";

/** String-aware scan for the first balanced `{…}` object at/after `from`. */
function balancedObject(text, from) {
  let start = -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = from; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) escape = false;
      else if (ch === "\\") escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      if (start === -1) start = i;
      depth += 1;
    } else if (ch === "}") {
      if (start === -1) continue;
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Extract the JSON object assigned to `marker` (e.g. "window.category")
 * from an HTML page. Handles storefronts that spread a serialized payload
 * into the assignment — `window.category = { ...{"items":[…]} }` falls
 * back to parsing the spread payload itself.
 */
export function parseWindowJson(html, marker = "window.category") {
  if (typeof html !== "string") return undefined;
  const markerIndex = html.indexOf(marker);
  if (markerIndex === -1) return undefined;
  const eq = html.indexOf("=", markerIndex);
  if (eq === -1 || eq - markerIndex > marker.length + 8) return undefined;
  const slice = balancedObject(html, eq);
  if (!slice) return undefined;
  try {
    return JSON.parse(slice);
  } catch { /* not pure JSON — try the spread payload below */ }
  const dots = slice.indexOf("...");
  if (dots !== -1) {
    const inner = balancedObject(slice, slice.indexOf("{", dots));
    if (inner) {
      try {
        return JSON.parse(inner);
      } catch { /* give up */ }
    }
  }
  return undefined;
}

export function parseEstarItems(json) {
  return Array.isArray(json?.items) ? json.items : [];
}

function isPriced(value) {
  return typeof value === "number" || (typeof value === "string" && value.trim() !== "");
}

function firstPricedVariant(item) {
  // Liquorland/eStar nest the variant array under stylecolour.
  const variants = Array.isArray(item?.variants)
    ? item.variants
    : Array.isArray(item?.stylecolour?.variants)
      ? item.stylecolour.variants
      : [];
  return variants.find((v) => isPriced(v?.unitprice) || isPriced(v?.saleprice)) ?? variants[0];
}

/** Default item → buildObservation spec mapping for the eStar family. */
export function mapEstarItem(item, store) {
  const variant = firstPricedVariant(item);
  const current = toCents(variant?.unitprice ?? variant?.saleprice);
  const id = item?.productid ?? item?.id;
  const name = item?.description ?? item?.name;
  if (id === undefined || !name || current === undefined || current <= 0) return undefined;
  const wasRaw = variant?.originalunitprice ?? variant?.baseunitprice;
  const hideWas = variant?.hidewasprice ?? item?.hidewasprice;
  const was = hideWas ? undefined : toCents(wasRaw);
  const urlPath = item?.url ?? (item?.stylecolour?.urlkey ? `${item.stylecolour.urlkey}` : undefined);
  // Barcode fields are only trusted as GTINs at EAN-8/13 lengths — some
  // retailers (Liquorland) keep 6-digit stock codes in the same field.
  const gtin = String(variant?.barcode ?? "").replace(/\D/g, "");
  return {
    slug: store.retailer,
    storeId: store.scopeId,
    storeName: store.name,
    origin: store.origin,
    retailerProductId: String(id),
    url: urlPath ? (urlPath.startsWith("http") ? urlPath : `${store.origin}/${urlPath.replace(/^\//, "")}`) : undefined,
    name,
    brand: typeof item?.label === "string" && item.label ? item.label : undefined,
    gtin: gtin.length >= 8 && gtin.length <= 14 ? gtin : undefined,
    image: item?.images?.[0]?.src ?? undefined,
    regularCents: was !== undefined && was > current ? was : current,
    ...(was !== undefined && was > current ? { promoCents: current } : {}),
  };
}

export class EstarCategoryClient {
  constructor(options = {}) {
    if (!options.slug || !options.origin) {
      throw new TypeError("EstarCategoryClient requires slug and origin");
    }
    if (!Array.isArray(options.categories) || options.categories.length === 0) {
      throw new TypeError("EstarCategoryClient requires categories: [path, ...]");
    }
    this.origin = options.origin.replace(/\/$/, "");
    this.slug = options.slug;
    this.scopeId = options.scopeId ?? "online";
    this.scopeName = options.scopeName ?? options.slug;
    this.categories = options.categories;
    // Server-side pagination param (e.g. "p" on Liquorland); eStar sites
    // paginate client-side, so leaving it undefined walks page 1 only.
    this.pageParam = options.pageParam;
    this.mapItem = options.mapItem ?? mapEstarItem;
    this.headers = { "user-agent": options.userAgent ?? BROWSER_UA, ...options.headers };
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#timeout = options.timeout ?? 25000;
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
    let url = `${this.origin}/${category.replace(/^\//, "")}`;
    if (this.pageParam && page > 1) {
      url += `${url.includes("?") ? "&" : "?"}${this.pageParam}=${page}`;
    }
    const html = await getText(url, {
      fetch: this.#fetch,
      headers: this.headers,
      timeout: this.#timeout,
      retry: this.#retry,
      operation: `estar ${this.slug} ${category} p${page}`,
    });
    return parseEstarItems(parseWindowJson(html));
  }

  async collectProducts({ maxPages = 20, observedAt } = {}) {
    const store = this.getStore();
    const seen = new Set();
    const observations = [];
    for (const category of this.categories) {
      const label = category.split("?")[0].split("/").filter(Boolean).join("/");
      const pages = this.pageParam ? maxPages : 1;
      for (let page = 1; page <= pages; page += 1) {
        let items;
        try {
          items = await this.listCategoryPage(category, page);
        } catch (error) {
          if (page === 1) {
            console.error(`estar ${this.slug}: skipping category ${category}: ${error.message}`);
            break;
          }
          throw error;
        }
        let fresh = 0;
        for (const item of items) {
          // Embedded payloads occasionally carry null/junk entries; they
          // must be skipped by the mapper, not crash the dedupe key.
          const key = String(item?.productid ?? item?.id ?? "");
          if (seen.has(key)) continue;
          seen.add(key);
          const spec = this.mapItem(item, store);
          const observation = spec ? buildObservation({ ...spec, observedAt }) : undefined;
          if (observation) {
            if (label) {
              observation.product.categories = [label, ...(observation.product.categories ?? [])];
            }
            observations.push(observation);
            fresh += 1;
          }
        }
        if (fresh === 0) break;
      }
    }
    return observations;
  }
}
