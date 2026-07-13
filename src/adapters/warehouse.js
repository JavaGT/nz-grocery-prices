import { execFile } from "node:child_process";
import { promisify } from "node:util";

const DEFAULT_ORIGIN = "https://www.thewarehouse.co.nz";
const DEFAULT_CATEGORY = "foodhouseholdpets-fooddrink";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36";
const execFileAsync = promisify(execFile);

function assertOk(response, operation) {
  if (response.ok) return response;
  throw new Error(
    `The Warehouse ${operation} failed: ${response.status} ${response.statusText}`,
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

function cents(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : undefined;
}

function totalItems(html) {
  const match = html.match(/of\s+([\d,]+)\s+(?:products|results)/i);
  return match ? Number(match[1].replaceAll(",", "")) : undefined;
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

export function toWarehouseObservation(product, store, options = {}) {
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
      id: `warehouse:${product.id}`,
      name: product.name,
      ...(product.brand && product.brand !== "na" ? { brand: product.brand } : {}),
      ...(product.productEAN && product.productEAN !== "na" ? { gtin: product.productEAN } : {}),
      ...(categories.length ? { categories } : {}),
      ...(product.image ? { images: { primary: product.image } } : {}),
    },
    store: {
      id: store.id,
      retailer: "warehouse",
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
            id: `warehouse:${product.id}:${regularCents}:${promoCents}`,
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
      adapter: "warehouse",
      url: new URL(product.path || `/p/${product.id}.html`, options.origin ?? DEFAULT_ORIGIN).toString(),
    },
  };
}

export class WarehouseClient {
  #fetch;
  #headers;
  #transport;

  constructor(options = {}) {
    this.origin = (options.origin ?? DEFAULT_ORIGIN).replace(/\/$/, "");
    this.category = options.category ?? DEFAULT_CATEGORY;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.scopeId = options.scopeId ?? "national-online";
    this.scopeName = options.scopeName ?? "The Warehouse Online";
    this.region = options.region;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#transport = options.transport ?? (options.fetch ? "fetch" : "curl");
    this.curlPath = options.curlPath ?? "curl";
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
        await this.#fetch(url, { headers }),
        url.pathname,
      );
      return response.text();
    }
    if (this.#transport !== "curl") {
      throw new TypeError(`Unsupported Warehouse transport: ${this.#transport}`);
    }

    const headerArguments = Object.entries(headers)
      .filter(([name]) => name.toLocaleLowerCase("en-NZ") !== "user-agent")
      .flatMap(([name, value]) => ["--header", `${name}: ${value}`]);
    const { stdout } = await execFileAsync(
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
      { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 },
    );
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
