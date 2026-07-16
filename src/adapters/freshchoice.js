import { fetchWithRetry } from "./fetch-with-retry.js";

const DEFAULT_ORIGIN = "https://queenstown.store.freshchoice.co.nz";
const DEFAULT_STORE_LIST_URL = "https://store.freshchoice.co.nz/";
const DEFAULT_USER_AGENT = "nz-grocery-prices/0.1";

function assertOk(response, operation) {
  if (response.ok) return response;
  throw new Error(
    `FreshChoice ${operation} failed: ${response.status} ${response.statusText}`,
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

function money(value) {
  const match = value?.match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  if (!match) return undefined;
  return Math.round(Number(match[1].replaceAll(",", "")) * 100);
}

function capture(block, pattern) {
  return block.match(pattern)?.[1];
}

function pageCount(html) {
  const pages = [...html.matchAll(/aria-label="Page (\d+)"/g)].map((match) => Number(match[1]));
  return Math.max(1, ...pages);
}

function titleCaseSlug(slug) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0]?.toLocaleUpperCase("en-NZ") ?? ""}${part.slice(1)}`)
    .join(" ");
}

/**
 * Parse the national FreshChoice store-chooser page into store records.
 * Each card exposes a name, address lines, and a per-store origin like
 * https://queenstown.store.freshchoice.co.nz.
 */
export function parseFreshChoiceStoreList(html) {
  if (!html) return [];
  const stores = [];
  const seen = new Set();
  // Match top-level StoreCard cards only (not nested StoreCard__* divs).
  const cardPattern =
    /<div class="StoreCard(?:\s[^"]*)?"[^>]*>[\s\S]*?<span class="StoreCard__Name">([^<]+)<\/span>([\s\S]*?)(?=<div class="StoreCard(?:\s[^"]*)?"|$)/g;

  for (const match of html.matchAll(cardPattern)) {
    const name = text(match[1]);
    const body = match[2] ?? "";
    const originMatch = body.match(
      /href="(https:\/\/([a-z0-9-]+)\.store\.freshchoice\.co\.nz)(?:\/[^"]*)?"/i,
    );
    if (!originMatch) continue;
    const origin = originMatch[1];
    const slug = originMatch[2];
    if (seen.has(slug)) continue;
    seen.add(slug);

    const detailsBody = body.match(
      /<span class="StoreCard__Details">([\s\S]*?)<\/span>/i,
    )?.[1] ?? "";
    const addressLines = detailsBody
      .split(/<br\s*\/?>/i)
      .map((line) => text(line))
      .filter((line) => line && !/^open\b/i.test(line) && !/^closed\b/i.test(line));
    const addressFromMaps = decodeHtml(
      (body.match(/maps\.google\.com\?q=([^"'#]+)/i)?.[1] ?? "").replaceAll("+", " "),
    ).trim();
    const address = addressLines.join(", ") || addressFromMaps;

    stores.push({
      id: `freshchoice:${slug}`,
      slug,
      retailer: "freshchoice",
      name: name.startsWith("FreshChoice") ? name : `FreshChoice ${name}`,
      ...(address ? { address: decodeHtml(address) } : {}),
      origin,
    });
  }

  // Fallback: origin links only (if markup changes but origins remain).
  if (stores.length === 0) {
    for (const match of html.matchAll(
      /https:\/\/([a-z0-9-]+)\.store\.freshchoice\.co\.nz/gi,
    )) {
      const slug = match[1].toLocaleLowerCase("en-NZ");
      if (seen.has(slug)) continue;
      seen.add(slug);
      stores.push({
        id: `freshchoice:${slug}`,
        slug,
        retailer: "freshchoice",
        name: `FreshChoice ${titleCaseSlug(slug)}`,
        origin: `https://${slug}.store.freshchoice.co.nz`,
      });
    }
  }

  return stores.sort((left, right) => left.name.localeCompare(right.name, "en-NZ"));
}

export function parseFreshChoiceProducts(html) {
  const starts = [...html.matchAll(/<div class="talker ([^"]*)"[^>]*data-talker[^>]*id="line_([^"]+)"[^>]*>/g)];
  return starts.map((match, index) => {
    const block = html.slice(match.index, starts[index + 1]?.index ?? html.length);
    const classes = match[1];
    const id = match[2];
    const path = decodeHtml(capture(block, /<a href="([^"]+)"[^>]*>\s*<figure>/) ?? "");
    const rawName = capture(block, /<div class="talker__name[^>]*"[^>]*title="([^"]*)"/);
    const productName = text(rawName ?? capture(block, /<span class="talker__product-name">([\s\S]*?)<\/span>/));
    const sellCents = money(text(capture(block, /<strong class="price__sell"[^>]*>([\s\S]*?)<\/strong>/)));
    const wasCents = money(text(capture(block, /<span class="talker__prices__was[^>]*>([\s\S]*?)<\/span>/)));
    const unit = text(capture(block, /<span class="price__units[^>]*>([\s\S]*?)<\/span>/));
    const comparative = text(capture(block, /<span class="[^"]*talker__prices__comparison[^"]*"[^>]*>([\s\S]*?)<\/span>/));
    const image = decodeHtml(capture(block, /<img[^>]+src="([^"]+)"/) ?? "");
    const isSpecial = /(?:^|\s)(?:special|talker--Special)(?:\s|$)/.test(classes);

    return {
      id,
      name: productName,
      path,
      sellCents,
      wasCents,
      unit,
      comparative,
      image,
      isSpecial,
      classes: classes.split(/\s+/).filter(Boolean),
    };
  }).filter((product) => product.id && product.name && Number.isInteger(product.sellCents));
}

export function toFreshChoiceObservation(product, store, options = {}) {
  if (!product.id || !Number.isInteger(product.sellCents)) return undefined;
  const currentCents = product.sellCents;
  const regularCents = product.wasCents ?? currentCents;
  const isSpecial = product.isSpecial || regularCents > currentCents;

  return {
    product: {
      id: `freshchoice:${product.id}`,
      name: product.name,
      ...(product.image ? { images: { primary: product.image } } : {}),
    },
    store: {
      id: store.id,
      retailer: "freshchoice",
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
            id: `freshchoice:${product.id}:${regularCents}:${currentCents}`,
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
      adapter: "freshchoice",
      url: new URL(product.path || `/lines/${product.id}`, options.origin ?? DEFAULT_ORIGIN).toString(),
    },
  };
}

export class FreshChoiceClient {
  #fetch;
  #headers;
  #signal;
  #timeout;
  #retry;

  constructor(options = {}) {
    this.origin = (options.origin ?? DEFAULT_ORIGIN).replace(/\/$/, "");
    const hostname = new URL(this.origin).hostname;
    this.storeSlug = options.storeSlug ?? hostname.split(".")[0];
    this.storeName = options.storeName ?? `FreshChoice ${titleCaseSlug(this.storeSlug)}`;
    this.storeAddress = options.storeAddress;
    this.storeListUrl = options.storeListUrl ?? DEFAULT_STORE_LIST_URL;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#signal = options.signal ?? undefined;
    this.#timeout = options.timeout ?? 15000;
    this.#retry = options.retry;
    this.#headers = { ...options.headers };
  }

  getStore() {
    return {
      id: `freshchoice:${this.storeSlug}`,
      retailer: "freshchoice",
      name: this.storeName,
      ...(this.storeAddress ? { address: this.storeAddress } : {}),
      origin: this.origin,
    };
  }

  /**
   * List every FreshChoice storefront from the national store-chooser page.
   * Returns records with { id, slug, name, address?, origin }.
   */
  async listStores() {
    const listUrl = this.storeListUrl ?? DEFAULT_STORE_LIST_URL;
    const response = assertOk(
      await fetchWithRetry(listUrl, {
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
    return parseFreshChoiceStoreList(await response.text());
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
    if (!options.query?.trim()) throw new TypeError("FreshChoice search requires a query");
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
      totalPages = page === 1 ? pageCount(html) : totalPages;
      page += 1;
    } while (page <= totalPages && page <= maxPages);

    return [...products.values()]
      .map((product) => toFreshChoiceObservation(product, store, {
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
