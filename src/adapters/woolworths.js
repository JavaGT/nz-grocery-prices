import { fetchWithRetry } from "./fetch-with-retry.js";

const DEFAULT_ORIGIN = "https://www.woolworths.co.nz";
const DEFAULT_USER_AGENT = "nz-grocery-prices/0.1";

function assertOk(response, operation) {
  if (response.ok) return response;
  throw new Error(
    `Woolworths ${operation} failed: ${response.status} ${response.statusText}`,
  );
}

function cents(value) {
  return Number.isFinite(value) ? Math.round(value * 100) : undefined;
}

function productName(product) {
  const name = product.name?.trim();
  const size = product.size?.volumeSize?.trim();
  if (!size || name?.toLocaleLowerCase("en-NZ").includes(size.toLocaleLowerCase("en-NZ"))) {
    return name;
  }
  return `${name} ${size}`;
}

/**
 * Minimal cookie jar for sticky Woolworths sessions.
 * Store switching is session-bound (ASP.NET_SessionId + related cookies).
 */
export class CookieJar {
  #cookies = new Map();

  constructor(initialCookieHeader = "") {
    this.mergeHeader(initialCookieHeader);
  }

  mergeHeader(header) {
    if (!header) return;
    for (const part of String(header).split(";")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const name = trimmed.slice(0, eq).trim();
      const value = trimmed.slice(eq + 1).trim();
      if (name) this.#cookies.set(name, value);
    }
  }

  storeFromResponse(response) {
    const setCookies =
      typeof response.headers.getSetCookie === "function"
        ? response.headers.getSetCookie()
        : [];
    for (const raw of setCookies) {
      const pair = raw.split(";", 1)[0] ?? "";
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;
      // Empty value clears the cookie (common delete pattern).
      if (value === "") this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }

  header() {
    if (this.#cookies.size === 0) return "";
    return [...this.#cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
  }

  clear() {
    this.#cookies.clear();
  }
}

/** Avoid "Woolworths Woolworths …" when the API address already includes the brand. */
export function woolworthsStoreName(fulfilment) {
  const address = String(fulfilment?.address ?? "").trim();
  if (!address) return `Woolworths ${fulfilment?.fulfilmentStoreId ?? "store"}`;
  if (/^woolworths\b/i.test(address)) return address;
  return `Woolworths ${address}`;
}

/**
 * Parse the national pickup-address list into unique store records.
 * The API returns the same stores under regional area buckets and an
 * "All Pick up locations" bucket — we dedupe by pickup address id.
 * Remote halls/lockers (no "Woolworths" name) are dropped by default.
 */
export function parseWoolworthsPickupStores(payload, options = {}) {
  const includeRemote = Boolean(options.includeRemote);
  const byId = new Map();

  for (const area of payload?.storeAreas ?? []) {
    for (const store of area.storeAddresses ?? []) {
      if (store?.id == null) continue;
      const id = String(store.id);
      if (byId.has(id)) continue;
      const name = String(store.name ?? "").trim() || `Pickup ${id}`;
      const isWoolworthsStore = /^woolworths\b/i.test(name);
      if (!includeRemote && !isWoolworthsStore) continue;
      byId.set(id, {
        id,
        pickupAddressId: Number(store.id),
        retailer: "woolworths",
        name,
        ...(store.address ? { address: String(store.address).trim() } : {}),
      });
    }
  }

  return [...byId.values()].sort((left, right) =>
    left.name.localeCompare(right.name, "en-NZ"),
  );
}

export function toWoolworthsObservation(product, fulfilment, options = {}) {
  const originalCents = cents(product.price?.originalPrice);
  const saleCents = cents(product.price?.salePrice);
  const currentCents = saleCents ?? originalCents;
  if (!product.sku || currentCents === undefined || !fulfilment?.fulfilmentStoreId) {
    return undefined;
  }

  const isClubPrice = Boolean(product.price?.isClubPrice);
  const isSpecial = Boolean(product.price?.isSpecial || product.productTag?.tagType === "IsSpecial");
  const observedAt = options.observedAt ?? new Date().toISOString();
  const promotionStart = product.price?.promotionStartDate;
  const promotionEnd = product.price?.promotionEndDate;
  const categories = product.departments?.map((department) => department.name).filter(Boolean);

  return {
    product: {
      id: `woolworths:${product.sku}`,
      name: productName(product),
      ...(product.brand ? { brand: product.brand } : {}),
      ...(product.barcode ? { gtin: product.barcode } : {}),
      ...(categories?.length ? { categories } : {}),
      ...(product.images ? { images: structuredClone(product.images) } : {}),
    },
    store: {
      id: `woolworths:${fulfilment.fulfilmentStoreId}`,
      retailer: "woolworths",
      name: woolworthsStoreName(fulfilment),
      ...(fulfilment.address ? { address: fulfilment.address } : {}),
    },
    price: {
      currency: "NZD",
      regularCents: originalCents ?? currentCents,
      ...(isClubPrice
        ? { memberCents: currentCents }
        : isSpecial
          ? { promoCents: currentCents }
          : {}),
      ...(Number.isFinite(product.size?.cupPrice)
        ? {
            comparative: {
              cents: cents(product.size.cupPrice),
              measure: product.size.cupMeasure,
              display: `$${product.size.cupPrice.toFixed(2)} / ${product.size.cupMeasure}`,
            },
          }
        : {}),
    },
    ...(isSpecial || isClubPrice
      ? {
          promotion: {
            id: ["woolworths", product.sku, promotionStart, promotionEnd, currentCents]
              .filter((part) => part !== null && part !== undefined)
              .join(":"),
            type: isClubPrice ? "MEMBER_PRICE" : "SPECIAL",
            memberOnly: isClubPrice,
            ...(Number.isFinite(product.price?.savePrice)
              ? { saveCents: cents(product.price.savePrice) }
              : {}),
            ...(Number.isFinite(product.price?.savePercentage)
              ? { savePercent: product.price.savePercentage }
              : {}),
            ...(promotionStart ? { startsAt: promotionStart } : {}),
            ...(promotionEnd ? { endsAt: promotionEnd } : {}),
          },
        }
      : {}),
    observedAt,
    source: {
      retailerProductId: String(product.sku),
      adapter: "woolworths",
      url: `${options.origin ?? DEFAULT_ORIGIN}/shop/productdetails?stockcode=${encodeURIComponent(product.sku)}&name=${encodeURIComponent(product.slug ?? product.name ?? "product")}`,
    },
  };
}

export class WoolworthsClient {
  #fetch;
  #headers;
  #signal;
  #timeout;
  #retry;
  #jar;
  #pickupMethodReady = false;

  constructor(options = {}) {
    this.origin = options.origin ?? DEFAULT_ORIGIN;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#signal = options.signal ?? undefined;
    this.#timeout = options.timeout ?? 15000;
    this.#retry = options.retry;
    this.#headers = { ...options.headers };
    // Session cookies live in the jar (seeded by WOOLWORTHS_COOKIE if set).
    // Do not also put cookie on static headers — that would double-send.
    this.#jar = options.cookieJar ?? new CookieJar(options.cookie ?? "");
  }

  async #request(path, options = {}) {
    const method = options.method ?? "GET";
    const headers = {
      accept: "application/json",
      "content-type": "application/json",
      referer: `${this.origin}/shop/specials`,
      "user-agent": this.userAgent,
      "x-requested-with": "OnlineShopping.WebApp",
      ...this.#headers,
    };
    const jarCookie = this.#jar.header();
    if (jarCookie) {
      headers.cookie = headers.cookie ? `${headers.cookie}; ${jarCookie}` : jarCookie;
    }

    const response = assertOk(
      await fetchWithRetry(`${this.origin}${path}`, {
        method,
        headers,
        ...(options.body !== undefined
          ? { body: typeof options.body === "string" ? options.body : JSON.stringify(options.body) }
          : {}),
        fetch: this.#fetch,
        signal: this.#signal,
        timeout: this.#timeout,
        retry: this.#retry,
      }),
      path,
    );
    this.#jar.storeFromResponse(response);

    const text = await response.text();
    if (!text) return {};
    const result = JSON.parse(text);
    if (result.isSuccessful === false) {
      throw new Error(`Woolworths ${path} returned an unsuccessful response`);
    }
    return result;
  }

  async listDeals(options = {}) {
    const parameters = new URLSearchParams({
      target: "specials",
      useRankedSpecials: "true",
      page: String(options.page ?? 1),
      size: String(options.size ?? 100),
    });
    return this.#request(`/api/v1/products?${parameters}`);
  }

  /**
   * List every Woolworths click-and-collect store (~180).
   * Requires a live session (warms cookies automatically).
   */
  async listStores(options = {}) {
    // Warm the session so subsequent PUTs share ASP.NET_SessionId.
    await this.listDeals({ page: 1, size: 1 });
    const payload = await this.#request("/api/v1/addresses/pickup-addresses");
    return parseWoolworthsPickupStores(payload, options);
  }

  /**
   * Resolve a store by pickup address id, name substring, or address substring.
   */
  async resolveStore(query, options = {}) {
    const needle = String(query ?? "").trim().toLocaleLowerCase("en-NZ");
    if (!needle) throw new Error("Store query is required");
    const stores = await this.listStores(options);
    const exactId = stores.find((store) => store.id === needle || String(store.pickupAddressId) === needle);
    if (exactId) return exactId;
    const matches = stores.filter(
      (store) =>
        store.name.toLocaleLowerCase("en-NZ").includes(needle) ||
        store.address?.toLocaleLowerCase("en-NZ").includes(needle),
    );
    if (matches.length === 1) return matches[0];
    if (matches.length === 0) {
      throw new Error(`No Woolworths store matched "${query}"`);
    }
    const names = matches
      .slice(0, 8)
      .map((store) => store.name)
      .join(", ");
    throw new Error(
      `Ambiguous Woolworths store "${query}" (${matches.length} matches): ${names}`,
    );
  }

  /**
   * Switch the session to pickup at the given store.
   * Prices on subsequent product requests reflect that fulfilment store.
   */
  async setPickupStore(pickupAddressId) {
    const addressId = Number(pickupAddressId);
    if (!Number.isFinite(addressId)) {
      throw new TypeError("pickupAddressId must be a number");
    }

    if (!this.#pickupMethodReady) {
      // Ensure we have a session cookie before mutating fulfilment.
      await this.listDeals({ page: 1, size: 1 });
      await this.#request("/api/v1/fulfilment/my/methods/pickup", {
        method: "PUT",
        body: {},
      });
      this.#pickupMethodReady = true;
    }

    const result = await this.#request("/api/v1/fulfilment/my/pickup-addresses", {
      method: "PUT",
      body: { addressId },
    });
    const fulfilment = result.context?.fulfilment;
    if (!fulfilment?.fulfilmentStoreId) {
      throw new Error(
        `Woolworths did not confirm fulfilment after selecting pickup address ${addressId}`,
      );
    }
    if (
      fulfilment.pickupAddressId &&
      Number(fulfilment.pickupAddressId) !== addressId
    ) {
      throw new Error(
        `Woolworths fulfilment pickupAddressId ${fulfilment.pickupAddressId} did not match requested ${addressId}`,
      );
    }
    return {
      id: String(fulfilment.fulfilmentStoreId),
      name: woolworthsStoreName(fulfilment),
      address: fulfilment.address,
      retailer: "woolworths",
      pickupAddressId: fulfilment.pickupAddressId ?? addressId,
      context: structuredClone(fulfilment),
    };
  }

  async getStore() {
    const result = await this.listDeals({ page: 1, size: 1 });
    const fulfilment = result.context?.fulfilment;
    if (!fulfilment?.fulfilmentStoreId) {
      throw new Error("Woolworths response did not identify its fulfilment store");
    }
    return {
      id: String(fulfilment.fulfilmentStoreId),
      name: woolworthsStoreName(fulfilment),
      address: fulfilment.address,
      retailer: "woolworths",
      context: structuredClone(fulfilment),
    };
  }

  async collectDeals(options = {}) {
    const observedAt = options.observedAt ?? new Date().toISOString();
    const size = options.size ?? 100;
    const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
    const products = new Map();
    let page = 1;
    let totalPages = 1;
    let fulfilment;

    do {
      const result = await this.listDeals({ page, size });
      const pageFulfilment = result.context?.fulfilment;
      if (!pageFulfilment?.fulfilmentStoreId) {
        throw new Error("Woolworths response did not identify its fulfilment store");
      }
      if (
        fulfilment &&
        fulfilment.fulfilmentStoreId !== pageFulfilment.fulfilmentStoreId
      ) {
        throw new Error("Woolworths fulfilment store changed during collection");
      }
      fulfilment = pageFulfilment;

      for (const product of result.products?.items ?? []) {
        if (product.sku) products.set(String(product.sku), product);
      }
      totalPages = Math.max(1, Math.ceil((result.products?.totalItems ?? products.size) / size));
      page += 1;
    } while (page <= totalPages && page <= maxPages);

    return [...products.values()]
      .map((product) =>
        toWoolworthsObservation(product, fulfilment, {
          observedAt,
          origin: this.origin,
        }),
      )
      .filter(Boolean);
  }
}
