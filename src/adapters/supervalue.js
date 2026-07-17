import { fetchWithRetry } from "./fetch-with-retry.js";
import { parseFreshChoiceProducts } from "./freshchoice.js";

// SuperValue is the sister banner to FreshChoice on the same myfoodlink
// storefront platform, so product/specials markup ("talker" cards) is
// identical and reuses the FreshChoice parser. Only store discovery differs:
// the national chooser is a JS-rendered MultiPage whose content loads from
// /multipage, and store origins are resolved via /{chooserId}/i_choose_you
// redirects rather than direct subdomain links.
const DEFAULT_ORIGIN = "https://milton.store.supervalue.co.nz";
const DEFAULT_STORE_LIST_URL = "https://store.supervalue.co.nz/multipage";
const DEFAULT_CHOOSER_ORIGIN = "https://store.supervalue.co.nz";
const DEFAULT_USER_AGENT = "nz-grocery-prices/0.1";

export { parseFreshChoiceProducts as parseSuperValueProducts };

function assertOk(response, operation) {
  if (response.ok) return response;
  throw new Error(
    `SuperValue ${operation} failed: ${response.status} ${response.statusText}`,
  );
}

function decodeHtml(value = "") {
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

function text(value = "") {
  return decodeHtml(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function titleCaseSlug(slug) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0]?.toLocaleUpperCase("en-NZ") ?? ""}${part.slice(1)}`)
    .join(" ");
}

/**
 * Parse the /multipage chooser content into unique webshop links.
 * Each StoreLink anchor carries a 24-hex chooser id; the same store repeats
 * under island and search buckets, so entries are deduped by chooser id.
 * Returns records with { chooserId, name, address? } — the storefront origin
 * still has to be resolved via resolveStoreOrigins()/listStores().
 */
export function parseSuperValueStoreLinks(html) {
  if (!html) return [];
  const stores = [];
  const seen = new Set();
  const linkPattern =
    /<a class="StoreLink[^"]*" href="\/([a-f0-9]{24})\/i_choose_you">([\s\S]*?)<\/a>/g;

  for (const match of html.matchAll(linkPattern)) {
    const chooserId = match[1];
    if (seen.has(chooserId)) continue;
    seen.add(chooserId);
    const body = match[2] ?? "";
    const rawName = text(body.match(/<span class="StoreLink__Name">([\s\S]*?)<\/span>/i)?.[1] ?? "");
    if (!rawName) continue;
    const details = body.match(/<span class="StoreLink__Details">([\s\S]*?)<\/span>/i)?.[1] ?? "";
    const addressLines = details
      .split(/<br\s*\/?>/i)
      .map((line) => text(line.replace(/<span class="StoreLink__Tagline[\s\S]*$/i, "")
        .replace(/<strong>[\s\S]*$/i, "")))
      .filter(Boolean);
    const address = addressLines.join(", ");

    stores.push({
      chooserId,
      retailer: "supervalue",
      name: rawName.startsWith("SuperValue") ? rawName : `SuperValue ${rawName}`,
      ...(address ? { address } : {}),
    });
  }

  return stores.sort((left, right) => left.name.localeCompare(right.name, "en-NZ"));
}

export function toSuperValueObservation(product, store, options = {}) {
  if (!product.id || !Number.isInteger(product.sellCents)) return undefined;
  const currentCents = product.sellCents;
  const regularCents = product.wasCents ?? currentCents;
  const isSpecial = product.isSpecial || regularCents > currentCents;

  return {
    product: {
      id: `supervalue:${product.id}`,
      name: product.name,
      ...(product.image ? { images: { primary: product.image } } : {}),
    },
    store: {
      id: store.id,
      retailer: "supervalue",
      name: store.name,
      ...(store.address ? { address: store.address } : {}),
    },
    price: {
      currency: "NZD",
      regularCents,
      ...(isSpecial ? { promoCents: currentCents } : {}),
      ...(product.comparative
        ? { comparative: { display: product.comparative } }
        : product.unit
          ? { comparative: { display: product.unit } }
          : {}),
    },
    ...(isSpecial
      ? {
          promotion: {
            id: `supervalue:${product.id}:${regularCents}:${currentCents}`,
            type: "SPECIAL",
            memberOnly: false,
            ...(regularCents > currentCents
              ? {
                  saveCents: regularCents - currentCents,
                  savePercent: Math.round(((regularCents - currentCents) / regularCents) * 10_000) / 100,
                }
              : {}),
          },
        }
      : {}),
    observedAt: options.observedAt ?? new Date().toISOString(),
    source: {
      retailerProductId: product.id,
      adapter: "supervalue",
      url: new URL(product.path || `/lines/${product.id}`, options.origin ?? DEFAULT_ORIGIN).toString(),
    },
  };
}

export class SuperValueClient {
  #fetch;
  #headers;
  #signal;
  #timeout;
  #retry;

  constructor(options = {}) {
    this.origin = (options.origin ?? DEFAULT_ORIGIN).replace(/\/$/, "");
    const hostname = new URL(this.origin).hostname;
    this.storeSlug = options.storeSlug ?? hostname.split(".")[0];
    this.storeName = options.storeName ?? `SuperValue ${titleCaseSlug(this.storeSlug)}`;
    this.storeAddress = options.storeAddress;
    this.storeListUrl = options.storeListUrl ?? DEFAULT_STORE_LIST_URL;
    this.chooserOrigin = options.chooserOrigin ?? DEFAULT_CHOOSER_ORIGIN;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#signal = options.signal ?? undefined;
    this.#timeout = options.timeout ?? 15000;
    this.#retry = options.retry;
    this.#headers = { ...options.headers };
  }

  getStore() {
    return {
      id: `supervalue:${this.storeSlug}`,
      retailer: "supervalue",
      name: this.storeName,
      ...(this.storeAddress ? { address: this.storeAddress } : {}),
      origin: this.origin,
    };
  }

  /**
   * List every SuperValue webshop from the national chooser (currently ~3 —
   * most SuperValue stores have no online shop). Each store's origin is
   * resolved by reading the i_choose_you redirect without following it.
   * Returns records with { id, slug, name, address?, origin, chooserId }.
   */
  async listStores() {
    const response = assertOk(
      await fetchWithRetry(this.storeListUrl, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": this.userAgent,
          ...this.#headers,
        },
        fetch: this.#fetch,
        signal: this.#signal,
        timeout: this.#timeout,
        retry: this.#retry,
      }),
      "store list",
    );
    const links = parseSuperValueStoreLinks(await response.text());

    const stores = [];
    for (const link of links) {
      const redirect = await fetchWithRetry(
        `${this.chooserOrigin}/${link.chooserId}/i_choose_you`,
        {
          redirect: "manual",
          headers: {
            accept: "text/html,application/xhtml+xml",
            "user-agent": this.userAgent,
            ...this.#headers,
          },
          fetch: this.#fetch,
          signal: this.#signal,
          timeout: this.#timeout,
          retry: this.#retry,
        },
      );
      const location = redirect.headers?.get?.("location") ?? "";
      const originMatch = location.match(
        /^(https:\/\/([a-z0-9-]+)\.store\.supervalue\.co\.nz)/i,
      );
      if (!originMatch) continue;
      stores.push({
        id: `supervalue:${originMatch[2]}`,
        slug: originMatch[2],
        origin: originMatch[1],
        ...link,
      });
    }
    return stores;
  }

  async #request(path, parameters = {}) {
    const url = new URL(path, this.origin);
    for (const [name, value] of Object.entries(parameters)) {
      if (value !== undefined) url.searchParams.append(name, String(value));
    }
    const response = assertOk(
      await fetchWithRetry(url, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": this.userAgent,
          ...this.#headers,
        },
        fetch: this.#fetch,
        signal: this.#signal,
        timeout: this.#timeout,
        retry: this.#retry,
      }),
      url.pathname,
    );
    return response.text();
  }

  listDeals(options = {}) {
    return this.#request("/specials", {
      page: options.page ?? 1,
      "q[]": "special:1",
    });
  }

  searchProducts(options = {}) {
    if (!options.query?.trim()) throw new TypeError("SuperValue search requires a query");
    return this.#request("/search", {
      q: options.query.trim(),
      page: options.page ?? 1,
    });
  }

  async #collect(loadPage, options = {}) {
    const observedAt = options.observedAt ?? new Date().toISOString();
    const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
    const store = this.getStore();
    const products = new Map();
    let page = 1;
    let totalPages = 1;

    do {
      const html = await loadPage(page);
      for (const product of parseFreshChoiceProducts(html)) products.set(product.id, product);
      if (page === 1) {
        const pages = [...html.matchAll(/aria-label="Page (\d+)"/g)].map((match) => Number(match[1]));
        totalPages = Math.max(1, ...pages);
      }
      page += 1;
    } while (page <= totalPages && page <= maxPages);

    return [...products.values()]
      .map((product) => toSuperValueObservation(product, store, {
        observedAt,
        origin: this.origin,
      }))
      .filter(Boolean);
  }

  collectDeals(options = {}) {
    return this.#collect((page) => this.listDeals({ page }), options);
  }

  collectProducts(options = {}) {
    return this.#collect(
      (page) => this.searchProducts({ query: options.query, page }),
      options,
    );
  }
}
