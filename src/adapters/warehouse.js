import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchWithRetry, readBodyText } from "./fetch-with-retry.js";

const DEFAULT_ORIGIN = "https://www.thewarehouse.co.nz";
const DEFAULT_CATEGORY = "foodhouseholdpets-fooddrink";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36";
const execFileAsync = promisify(execFile);

/** Process-level backstop behind curl's own `--max-time 30`. */
const CURL_EXEC_TIMEOUT_MS = 45_000;

/** Upper bound on stderr/stdout quoted from a failed curl into an Error. */
const MAX_CURL_ERROR_CHARS = 400;

/**
 * Build a bounded error message from a rejected curl execFile call. execFile
 * rejections quote the child's stderr (and the whole command line) in
 * `.message` — a blocked or failed transfer must not flood logs or breadth
 * warnings with an unbounded page body.
 */
export function summarizeCurlError(error, label) {
  const detail =
    (typeof error?.stderr === "string" && error.stderr.trim()) ||
    (typeof error?.stdout === "string" && error.stdout.trim()) ||
    error?.message ||
    String(error);
  const bounded = detail.replace(/\s+/g, " ").trim().slice(0, MAX_CURL_ERROR_CHARS);
  const status = [
    error?.code != null ? `exit ${error.code}` : null,
    error?.signal != null ? `signal ${error.signal}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return `The Warehouse curl request failed (${label})${status ? ` [${status}]` : ""}: ${bounded}`;
}

function assertOk(response, operation) {
  if (response.ok) return response;
  throw new Error(
    `The Warehouse ${operation} failed: ${response.status} ${response.statusText}`,
  );
}

// Numeric character references with NaN or out-of-range code points must not
// crash the whole parse (String.fromCodePoint throws RangeError); malformed
// entities are preserved verbatim instead.
function decodeCodePoint(entity, code) {
  return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : entity;
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
    .replace(/&#(\d+);/g, (entity, code) => decodeCodePoint(entity, Number(code)))
    .replace(/&#x([\da-f]+);/gi, (entity, code) => decodeCodePoint(entity, Number.parseInt(code, 16)));
}

function cents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : undefined;
}

function totalItems(html) {
  const match = html.match(/of\s+([\d,]+)\s+(?:products|results)/i);
  return match ? Number(match[1].replaceAll(",", "")) : undefined;
}

/** Grid result count from the "1 – N of M products" SFCC grid header. */
export function totalGridItems(html) {
  return totalItems(html);
}

function multibuy(callout) {
  const match = callout?.match(/(\d+)\s+for\s+\$\s*([\d,]+(?:\.\d{1,2})?)/i);
  if (!match) return undefined;
  const quantity = Number(match[1]);
  const totalCents = cents(match[2].replaceAll(",", ""));
  if (!quantity || totalCents === undefined) return undefined;
  return {
    quantity,
    totalCents,
    unitCents: Math.round(totalCents / quantity),
  };
}

export function parseWarehouseProducts(html) {
  const starts = [...html.matchAll(/<div class="product-tile"[^>]*data-gtm-product="([^"]+)"[^>]*>/g)];
  return starts.flatMap((match, index) => {
    let product;
    try {
      product = JSON.parse(decodeHtml(match[1]));
    } catch {
      return [];
    }

    const block = html.slice(match.index, starts[index + 1]?.index ?? html.length);
    const path = decodeHtml(block.match(/<a href="([^"]+)"[^>]*class="[^"]*embed-responsive/)?.[1] ?? "");
    const image = decodeHtml(block.match(/<img[\s\S]*?class="[^"]*tile-image[^"]*"[\s\S]*?src="([^"]+)"/)?.[1] ?? "");
    return [{ ...product, path, image }];
  });
}

/**
 * Generalized observation mapping for SFCC `product-tile` grids that carry
 * the `data-gtm-product` payload (The Warehouse, Noel Leeming, …). `slug`
 * (usually store.retailer) drives product/store/promotion identity.
 */
export function toSfccObservation(product, store, options = {}) {
  const slug = store.retailer ?? "warehouse";
  const currentCents = cents(product.price);
  const thenCents = cents(product.productThenPrice);
  if (!product.id || !product.name || currentCents === undefined) return undefined;

  const offer = multibuy(product.promotionCallOutMessage);
  const promoCents = offer?.unitCents ?? currentCents;
  const isSpecial =
    offer !== undefined ||
    (thenCents !== undefined && thenCents > currentCents) ||
    String(product.productBadges).includes("special");
  const regularCents = Math.max(currentCents, thenCents ?? currentCents);
  const categories = String(product.category ?? "").split("/").filter(Boolean);

  return {
    product: {
      id: `${slug}:${product.id}`,
      name: product.name,
      ...(product.brand && product.brand !== "na" ? { brand: product.brand } : {}),
      ...(product.productEAN && product.productEAN !== "na" ? { gtin: product.productEAN } : {}),
      ...(categories.length ? { categories } : {}),
      ...(product.image ? { images: { primary: product.image } } : {}),
    },
    store: {
      id: store.id,
      retailer: slug,
      name: store.name,
      ...(store.region ? { region: store.region } : {}),
    },
    price: {
      currency: "NZD",
      regularCents,
      ...(isSpecial ? { promoCents } : {}),
    },
    ...(isSpecial
      ? {
          promotion: {
            id: `${slug}:${product.id}:${regularCents}:${promoCents}`,
            type: offer ? "MULTIBUY" : "SPECIAL",
            memberOnly: false,
            ...(offer ? { threshold: offer.quantity, totalCents: offer.totalCents } : {}),
            ...(regularCents > promoCents
              ? {
                  saveCents: regularCents - promoCents,
                  savePercent: Math.round(((regularCents - promoCents) / regularCents) * 10_000) / 100,
                }
              : {}),
            ...(product.promotionCallOutMessage && product.promotionCallOutMessage !== "na"
              ? { description: product.promotionCallOutMessage }
              : {}),
          },
        }
      : {}),
    observedAt: options.observedAt ?? new Date().toISOString(),
    source: {
      retailerProductId: product.id,
      adapter: slug,
      url: new URL(product.path || `/p/${product.id}.html`, options.origin ?? DEFAULT_ORIGIN).toString(),
    },
  };
}

export function toWarehouseObservation(product, store, options = {}) {
  return toSfccObservation(product, { ...store, retailer: "warehouse" }, options);
}

export class WarehouseClient {
  #fetch;
  #headers;
  #transport;
  #execFile;
  #signal;
  #timeout;
  #retry;

  constructor(options = {}) {
    this.origin = (options.origin ?? DEFAULT_ORIGIN).replace(/\/$/, "");
    this.category = options.category ?? DEFAULT_CATEGORY;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.scopeId = options.scopeId ?? "national-online";
    this.scopeName = options.scopeName ?? "The Warehouse Online";
    this.region = options.region;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#signal = options.signal ?? undefined;
    this.#timeout = options.timeout ?? 15000;
    this.#retry = options.retry;
    this.#transport = options.transport ?? (options.fetch ? "fetch" : "curl");
    this.curlPath = options.curlPath ?? "curl";
    this.#execFile = options.execFile ?? execFileAsync;
    this.#headers = { ...options.headers };
  }

  getStore() {
    return {
      id: `warehouse:${this.scopeId}`,
      retailer: "warehouse",
      name: this.scopeName,
      ...(this.region ? { region: this.region } : {}),
      origin: this.origin,
    };
  }

  async #request(parameters) {
    const url = new URL("/search/updategrid", this.origin);
    for (const [name, value] of Object.entries(parameters)) {
      if (value !== undefined) url.searchParams.append(name, String(value));
    }
    const headers = {
      accept: "text/html,application/xhtml+xml",
      referer: `${this.origin}/c/food-pets-household/food-drink`,
      "user-agent": this.userAgent,
      ...this.#headers,
    };

    if (this.#transport === "fetch") {
      const response = assertOk(
        await fetchWithRetry(url, {
          headers,
          fetch: this.#fetch,
          signal: this.#signal,
          timeout: this.#timeout,
          retry: this.#retry,
        }),
        url.pathname,
      );
      return readBodyText(response, { label: `The Warehouse ${url.pathname}` });
    }
    if (this.#transport !== "curl") {
      throw new TypeError(`Unsupported Warehouse transport: ${this.#transport}`);
    }

    const headerArguments = Object.entries(headers)
      .filter(([name]) => name.toLocaleLowerCase("en-NZ") !== "user-agent")
      .flatMap(([name, value]) => ["--header", `${name}: ${value}`]);
    let stdout;
    try {
      ({ stdout } = await this.#execFile(
        this.curlPath,
        [
          "--silent",
          "--show-error",
          "--fail-with-body",
          "--location",
          "--compressed",
          "--max-time",
          "30",
          "--user-agent",
          headers["user-agent"],
          ...headerArguments,
          url.toString(),
        ],
        { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, timeout: CURL_EXEC_TIMEOUT_MS },
      ));
    } catch (error) {
      throw new Error(summarizeCurlError(error, url.pathname));
    }
    return stdout;
  }

  listDeals(options = {}) {
    const size = options.size ?? 32;
    return this.#request({
      cgid: this.category,
      pmid: "twl-discountedProducts",
      start: ((options.page ?? 1) - 1) * size,
      sz: size,
    });
  }

  searchProducts(options = {}) {
    if (!options.query?.trim()) throw new TypeError("The Warehouse search requires a query");
    const size = options.size ?? 32;
    return this.#request({
      q: options.query.trim(),
      start: ((options.page ?? 1) - 1) * size,
      sz: size,
    });
  }

  async #collect(loadPage, options = {}) {
    const observedAt = options.observedAt ?? new Date().toISOString();
    const size = options.size ?? 32;
    const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
    const includeMarketplace = options.includeMarketplace ?? false;
    const store = this.getStore();
    const products = new Map();
    let page = 1;
    let pages = 1;

    do {
      const html = await loadPage(page, size);
      for (const product of parseWarehouseProducts(html)) {
        if (includeMarketplace || !product.marketplaceProduct) products.set(product.id, product);
      }
      pages = Math.max(1, Math.ceil((totalItems(html) ?? products.size) / size));
      page += 1;
    } while (page <= pages && page <= maxPages);

    return [...products.values()]
      .map((product) => toWarehouseObservation(product, store, {
        observedAt,
        origin: this.origin,
      }))
      .filter(Boolean);
  }

  collectDeals(options = {}) {
    return this.#collect((page, size) => this.listDeals({ page, size }), options);
  }

  collectProducts(options = {}) {
    return this.#collect(
      (page, size) => this.searchProducts({ query: options.query, page, size }),
      options,
    );
  }
}
