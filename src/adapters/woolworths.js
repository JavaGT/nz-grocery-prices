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
    const response = assertOk(
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
    const result = await response.json();
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
