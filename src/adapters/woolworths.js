import { fetchWithRetry, parseJsonResponse } from "./fetch-with-retry.js";

const DEFAULT_ORIGIN = "https://www.woolworths.co.nz";
const DEFAULT_USER_AGENT = "nz-grocery-prices/0.1";

async function assertOk(response, operation) {
  if (response.ok) return response;
  // Cancel the unread error body so the connection is released instead of
  // staying pinned until garbage collection.
  try { await response.body?.cancel?.(); } catch { /* teardown is best-effort */ }
  throw new Error(
    `Woolworths ${operation} failed: ${response.status} ${response.statusText}`,
  );
}

function cents(value) {
  return Number.isFinite(value) ? Math.round(value * 100) : undefined;
}

// Guard for the collectDeals paging loop: it iterates products.items and
// derives the page count from products.totalItems, so a malformed envelope
// must fail naming the field instead of crashing with "items is not
// iterable" or silently truncating to one page (NaN page math always
// compares false).
function assertDealsEnvelope(result, path) {
  const { items, totalItems } = result?.products ?? {};
  if (items !== undefined && !Array.isArray(items)) {
    throw new Error(`Woolworths ${path}: response envelope has a non-array products.items`);
  }
  if (totalItems !== undefined && !Number.isFinite(Number(totalItems))) {
    throw new Error(`Woolworths ${path}: response envelope has a non-numeric products.totalItems`);
  }
  return result;
}

function productName(product) {
  const name = product.name?.trim();
  // A missing or blank name must stay optional (domain Product.name?);
  // never render the string "undefined" when a size is present.
  if (!name) return undefined;
  const size = product.size?.volumeSize?.trim();
  if (!size || name.toLocaleLowerCase("en-NZ").includes(size.toLocaleLowerCase("en-NZ"))) {
    return name;
  }
  return `${name} ${size}`;
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
  // A non-array departments payload must yield no categories, not a
  // "departments.map is not a function" crash.
  const departments = Array.isArray(product.departments) ? product.departments : [];
  const categories = departments.map((department) => department.name).filter(Boolean);

  return {
    product: {
      id: `woolworths:${product.sku}`,
      name: productName(product),
      ...(product.brand ? { brand: product.brand } : {}),
      ...(product.barcode ? { gtin: product.barcode } : {}),
      ...(categories.length ? { categories } : {}),
      ...(product.images ? { images: structuredClone(product.images) } : {}),
    },
    store: {
      id: `woolworths:${fulfilment.fulfilmentStoreId}`,
      retailer: "woolworths",
      name: `Woolworths ${fulfilment.address ?? fulfilment.fulfilmentStoreId}`,
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

  constructor(options = {}) {
    this.origin = options.origin ?? DEFAULT_ORIGIN;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#signal = options.signal ?? undefined;
    this.#timeout = options.timeout ?? 15000;
    this.#retry = options.retry;
    this.#headers = { ...options.headers };
    if (options.cookie) this.#headers.cookie = options.cookie;
  }

  async #request(path) {
    const response = await assertOk(
      await fetchWithRetry(`${this.origin}${path}`, {
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          referer: `${this.origin}/shop/specials`,
          "user-agent": this.userAgent,
          "x-requested-with": "OnlineShopping.WebApp",
          ...this.#headers,
        },
        fetch: this.#fetch,
        signal: this.#signal,
        timeout: this.#timeout,
        retry: this.#retry,
      }),
      path,
    );
    const result = await parseJsonResponse(response, `Woolworths ${path}`);
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

  async listProducts(options = {}) {
    const parameters = new URLSearchParams({
      target: options.target ?? "browse",
      page: String(options.page ?? 1),
      size: String(options.size ?? 100),
    });
    for (const name of ["dasFilter", "sort", "search", "useRankedSpecials"]) {
      if (options[name] !== undefined) parameters.set(name, String(options[name]));
    }
    return this.#request(`/api/v1/products?${parameters}`);
  }

  async listDepartments() {
    return this.#request("/api/v1/products/departments");
  }

  async getStore() {
    const result = await this.listDeals({ page: 1, size: 1 });
    const fulfilment = result.context?.fulfilment;
    if (!fulfilment?.fulfilmentStoreId) {
      throw new Error("Woolworths response did not identify its fulfilment store");
    }
    return {
      id: String(fulfilment.fulfilmentStoreId),
      name: `Woolworths ${fulfilment.address ?? fulfilment.fulfilmentStoreId}`,
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
      const result = assertDealsEnvelope(await this.listDeals({ page, size }), "/api/v1/products");
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

      const items = result.products?.items ?? [];
      for (const product of items) {
        if (product.sku) products.set(String(product.sku), product);
      }
      // An empty page means the API has nothing further. Without this guard an
      // inflated products.totalItems would page empty results forever when
      // maxPages is unbounded (the scripts' "--pages all" default).
      if (items.length === 0) break;
      // Validated by assertDealsEnvelope: totalItems, when present, is
      // numeric (Number() coercion tolerates numeric strings).
      totalPages = Math.max(1, Math.ceil((Number(result.products?.totalItems) || products.size) / size));
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
