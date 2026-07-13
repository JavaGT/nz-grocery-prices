const DEFAULT_ORIGIN = "https://queenstown.store.freshchoice.co.nz";
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

  constructor(options = {}) {
    this.origin = (options.origin ?? DEFAULT_ORIGIN).replace(/\/$/, "");
    const hostname = new URL(this.origin).hostname;
    this.storeSlug = options.storeSlug ?? hostname.split(".")[0];
    this.storeName = options.storeName ?? `FreshChoice ${titleCaseSlug(this.storeSlug)}`;
    this.storeAddress = options.storeAddress;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#fetch = options.fetch ?? globalThis.fetch;
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

  async #request(path, parameters = {}) {
    const url = new URL(path, this.origin);
    for (const [name, value] of Object.entries(parameters)) {
      if (value !== undefined) url.searchParams.append(name, String(value));
    }
    const response = assertOk(
      await this.#fetch(url, {
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": this.userAgent,
          ...this.#headers,
        },
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
