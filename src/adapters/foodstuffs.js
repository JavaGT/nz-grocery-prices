import { randomUUID } from "node:crypto";
import { fetchWithRetry, parseJsonResponse } from "./fetch-with-retry.js";

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (compatible; nz-grocery-prices/0.1; +https://github.com/)";

const BANNERS = {
  paknsave: {
    retailer: "paknsave",
    apiBanner: "PNS",
    storeBanner: "PNS",
    webOrigin: "https://www.paknsave.co.nz",
    apiOrigin: "https://api-prod.paknsave.co.nz",
  },
  newworld: {
    retailer: "newworld",
    apiBanner: "NW",
    storeBanner: "MNW",
    webOrigin: "https://www.newworld.co.nz",
    apiOrigin: "https://api-prod.newworld.co.nz",
  },
};

function assertOk(response, operation) {
  if (response.ok) return response;
  throw new Error(
    `Foodstuffs ${operation} failed: ${response.status} ${response.statusText}`,
  );
}

function centsFromProduct(product) {
  if (Number.isInteger(product.price)) return product.price;
  if (Number.isInteger(product.singlePrice?.price)) return product.singlePrice.price;
  if (Number.isInteger(product.multiPrice?.price)) return product.multiPrice.price;
  return undefined;
}

function bestPromotion(product) {
  // A malformed promotions payload (non-array) must fall through to the
  // decal fallback, not crash on .find.
  const promotions = Array.isArray(product.promotions) ? product.promotions : [];
  return (
    promotions.find((promotion) => promotion.bestPromotion) ??
    promotions[0] ??
    (product.decalCode
      ? {
          promoId: `decal:${product.decalCode}`,
          rewardType: "SPECIAL",
          cardDependencyFlag: false,
          decalImageUrl: product.decalImageUrl,
        }
      : undefined)
  );
}

// Facet-driven catalogue crawls append raw Algolia filter strings (e.g.
// `category0NI:"Chilled & Dairy"`); they join the search conjunction
// verbatim, so a non-string or blank entry is a caller bug.
function validatedExtraFilters(extraFilters) {
  if (extraFilters === undefined) return [];
  if (!Array.isArray(extraFilters)) {
    throw new TypeError("searchProducts extraFilters must be an array of filter strings");
  }
  extraFilters.forEach((filter, index) => {
    if (typeof filter !== "string" || filter.trim() === "") {
      throw new TypeError(`searchProducts extraFilters[${index}] must be a non-empty string`);
    }
  });
  return extraFilters;
}

// Guard for the pagination loops in collectDeals/collectProducts: they
// spread `products` and compare the page-count field, so a malformed
// envelope must fail naming the field instead of crashing with
// "undefined is not iterable" or silently truncating to one page.
function assertPagedEnvelope(envelope, pagesField, label) {
  if (!Array.isArray(envelope?.products)) {
    throw new Error(`${label}: response envelope has no products array`);
  }
  if (!Number.isFinite(envelope[pagesField])) {
    throw new Error(`${label}: response envelope has no numeric ${pagesField}`);
  }
  return envelope;
}

export function toPriceObservation(product, store, options = {}) {
  const currentCents = centsFromProduct(product);
  // No usable price or no string productId → not an observation. The id
  // guard must hold before .toLowerCase(), which would otherwise crash on
  // a priced-but-unidentified payload.
  if (
    currentCents === undefined ||
    typeof product.productId !== "string" ||
    product.productId === ""
  ) {
    return undefined;
  }

  const promotion = bestPromotion(product);
  const retailer = options.retailer ?? "paknsave";
  const observedAt = options.observedAt ?? new Date().toISOString();

  return {
    product: {
      id: `foodstuffs:${product.productId.toLowerCase()}`,
      name: [product.name, product.displayName ?? product.units].filter(Boolean).join(" "),
      ...(product.brand ? { brand: product.brand } : {}),
      ...(product.categoryTrees?.[0] || product.categories
        ? {
            categories:
              product.categories ?? Object.values(product.categoryTrees[0]).filter(Boolean),
          }
        : {}),
      ...(product.productImageUrls ? { images: structuredClone(product.productImageUrls) } : {}),
    },
    store: {
      id: `${retailer}:${store.id}`,
      retailer,
      name: store.name,
      ...(store.address ? { address: store.address } : {}),
      ...(store.region ? { region: store.region } : {}),
    },
    price: {
      currency: "NZD",
      regularCents: currentCents,
      ...(promotion ? { promoCents: currentCents } : {}),
      ...(product.singlePrice?.comparativePrice
        ? { comparative: structuredClone(product.singlePrice.comparativePrice) }
        : product.unitPrice
          ? { comparative: { display: product.unitPrice } }
        : {}),
    },
    ...(promotion
      ? {
          promotion: {
            id: promotion.promoId,
            type: promotion.rewardType,
            ...(promotion.threshold ? { threshold: promotion.threshold } : {}),
            ...(promotion.limit ? { limit: promotion.limit } : {}),
            memberOnly: Boolean(promotion.cardDependencyFlag),
            ...(promotion.decalImageUrl ? { imageUrl: promotion.decalImageUrl } : {}),
          },
        }
      : {}),
    observedAt,
    source: {
      retailerProductId: product.productId,
      adapter: `foodstuffs-${retailer}`,
      url: `${BANNERS[retailer]?.webOrigin ?? BANNERS.paknsave.webOrigin}/shop/product/${product.productId.toLowerCase().replaceAll("-", "_")}`,
    },
  };
}

export class FoodstuffsClient {
  #accessToken;
  #expiresAt = 0;
  #fetch;
  #fingerprint;
  #signal;
  #timeout;
  #retry;

  constructor(options = {}) {
    const banner = options.banner ?? "paknsave";
    const configuration = BANNERS[banner];
    if (!configuration) {
      throw new TypeError(`Unsupported Foodstuffs banner: ${banner}`);
    }

    this.banner = banner;
    this.retailer = configuration.retailer;
    this.apiBanner = configuration.apiBanner;
    this.webOrigin = options.webOrigin ?? configuration.webOrigin;
    this.apiOrigin = options.apiOrigin ?? configuration.apiOrigin;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#fingerprint = options.fingerprint ?? randomUUID().replaceAll("-", "");
    this.#signal = options.signal ?? undefined;
    this.#timeout = options.timeout ?? 15000;
    this.#retry = options.retry;
  }

  async #authenticate() {
    if (this.#accessToken && Date.now() < this.#expiresAt - 60_000) {
      return this.#accessToken;
    }

    const response = assertOk(
      await fetchWithRetry(`${this.webOrigin}/api/user/get-current-user`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": this.userAgent,
        },
        body: JSON.stringify({
          fingerprintUser: this.#fingerprint,
          fingerprintGuest: this.userAgent,
        }),
        fetch: this.#fetch,
        signal: this.#signal,
        timeout: this.#timeout,
        retry: this.#retry,
      }),
      "anonymous authentication",
    );
    const session = await parseJsonResponse(response, "Foodstuffs anonymous authentication");
    if (typeof session !== "object" || session === null) {
      throw new Error("Foodstuffs anonymous authentication returned a non-object payload");
    }
    if (!session.access_token) {
      throw new Error("Foodstuffs anonymous authentication returned no access token");
    }

    // A missing/unparseable expires_time used to silently become NaN, which
    // disabled the token cache (NaN comparisons are always false) and made
    // every request re-authenticate.
    const expiresAt = Date.parse(session.expires_time);
    if (!Number.isFinite(expiresAt)) {
      throw new Error(
        "Foodstuffs anonymous authentication returned an unparseable expires_time; expected a date string",
      );
    }

    this.#accessToken = session.access_token;
    this.#expiresAt = expiresAt;
    return this.#accessToken;
  }

  async #request(path, init = {}) {
    const accessToken = await this.#authenticate();
    const response = assertOk(
      await fetchWithRetry(`${this.apiOrigin}${path}`, {
        ...init,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${accessToken}`,
          origin: this.webOrigin,
          referer: `${this.webOrigin}/`,
          "user-agent": this.userAgent,
          ...init.headers,
        },
        fetch: this.#fetch,
        signal: this.#signal,
        timeout: this.#timeout,
        retry: this.#retry,
      }),
      path,
    );
    return parseJsonResponse(response, `Foodstuffs ${path}`);
  }

  async listStores(options = {}) {
    const result = await this.#request("/v1/edge/store");
    // A malformed envelope (WAF page parsed as JSON, schema change) must
    // name the field instead of crashing with "stores.filter is not a
    // function" inside getStore / all-stores loops.
    if (!Array.isArray(result?.stores)) {
      throw new Error("Foodstuffs store list: response envelope has no stores array");
    }
    const stores = result.stores;
    const query = options.query?.trim().toLocaleLowerCase("en-NZ");
    return stores
      .filter(
        (store) =>
          store.banner?.toLocaleUpperCase("en-NZ") ===
          BANNERS[this.banner].storeBanner,
      )
      .filter(
        (store) =>
          !query ||
          store.name.toLocaleLowerCase("en-NZ").includes(query) ||
          store.address?.toLocaleLowerCase("en-NZ").includes(query),
      );
  }

  async getStore(storeId) {
    const stores = await this.listStores();
    const store = stores.find((candidate) => candidate.id === storeId);
    if (!store) throw new Error(`Unknown ${this.retailer} store: ${storeId}`);
    return store;
  }

  /**
   * POST /v1/edge/search/paginated/products for one store.
   *
   * @param {object} options
   * @param {string} options.storeId Store to scope the search to.
   * @param {number} [options.page] Zero-based page index (default 0).
   * @param {number} [options.hitsPerPage] Page size, max 50 server-side.
   * @param {string} [options.region] "NI" or "SI" sort-order prefix.
   * @param {boolean} [options.onPromotion] Scope to on-promotion products.
   * @param {string} [options.query] Free-text query.
   * @param {string[]} [options.extraFilters] Raw Algolia filter strings
   *   (e.g. `category0NI:"Chilled & Dairy"`) appended verbatim to the
   *   filter conjunction with AND. Each entry must be a non-empty string;
   *   otherwise a TypeError is thrown. Facet totals in the response
   *   (`algoliaSearchResult.facets`, `totalHits`, `totalPages`) pass
   *   through unmodified.
   * @returns {Promise<object>} The search envelope as returned by the API.
   */
  async searchProducts(options) {
    if (!options?.storeId) throw new TypeError("searchProducts requires storeId");
    const page = options.page ?? 0;
    const hitsPerPage = options.hitsPerPage ?? 50;
    const region = options.region ?? "NI";
    const filters = [
      `stores:${options.storeId}`,
      ...(options.onPromotion ? [`onPromotion:${options.storeId}`] : []),
      ...validatedExtraFilters(options.extraFilters),
    ].join(" AND ");

    return this.#request("/v1/edge/search/paginated/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        algoliaQuery: {
          attributesToHighlight: [],
          attributesToRetrieve: [
            "productID",
            "Type",
            "sponsored",
            "category0NI",
            "category1NI",
            "category2NI",
          ],
          facets: ["brand", "category0NI", "category1NI", "productFacets", "tobacco"],
          filters,
          hitsPerPage,
          maxValuesPerFacet: 100,
          page,
          analyticsTags: ["nz-grocery-prices"],
          ...(options.query ? { query: options.query } : {}),
        },
        algoliaFacetQueries: [],
        storeId: options.storeId,
        hitsPerPage,
        page,
        sortOrder: `${region}_POPULARITY_ASC`,
        tobaccoQuery: false,
        precisionMedia: {
          adDomain: "CATEGORY_PAGE",
          adPositions: [],
          publishImpressionEvent: false,
          disableAds: true,
        },
      }),
    });
  }

  async listDeals(options) {
    return this.searchProducts({ ...options, onPromotion: true });
  }

  async listMobileDeals(options) {
    if (!options?.storeId) throw new TypeError("listMobileDeals requires storeId");
    return this.#request(
      `/mobile/ecomm-products/${this.apiBanner}/${options.storeId}/specials?page=${options.page ?? 0}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    );
  }

  async collectDeals(options) {
    if (!options?.storeId) throw new TypeError("collectDeals requires storeId");
    const store = options.store ?? (await this.getStore(options.storeId));
    const observedAt = options.observedAt ?? new Date().toISOString();
    const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
    const products = [];
    let page = 0;
    let totalPages = 1;

    do {
      const result = assertPagedEnvelope(
        await this.listMobileDeals({ storeId: store.id, page }),
        "numberOfPages",
        `Foodstuffs mobile specials (page ${page})`,
      );
      products.push(...result.products);
      totalPages = result.numberOfPages;
      page += 1;
    } while (page < totalPages && page < maxPages);

    return products
      .map((product) =>
        toPriceObservation(product, store, {
          retailer: this.retailer,
          observedAt,
        }),
      )
      .filter(Boolean);
  }

  async collectProducts(options) {
    if (!options?.storeId) throw new TypeError("collectProducts requires storeId");
    const store = options.store ?? (await this.getStore(options.storeId));
    const observedAt = options.observedAt ?? new Date().toISOString();
    const maxPages = options.maxPages ?? Number.POSITIVE_INFINITY;
    const products = [];
    let page = 0;
    let totalPages = 1;

    do {
      const result = assertPagedEnvelope(
        await this.searchProducts({
          storeId: store.id,
          region: store.region,
          page,
          hitsPerPage: options.hitsPerPage ?? 50,
          onPromotion: options.onPromotion ?? false,
          query: options.query,
        }),
        "totalPages",
        `Foodstuffs product search (page ${page})`,
      );
      products.push(...result.products);
      totalPages = result.totalPages;
      page += 1;
    } while (page < totalPages && page < maxPages);

    return products
      .map((product) =>
        toPriceObservation(product, store, {
          retailer: this.retailer,
          observedAt,
        }),
      )
      .filter(Boolean);
  }
}

export class PaknsaveClient extends FoodstuffsClient {
  constructor(options = {}) {
    super({ ...options, banner: "paknsave" });
  }
}

export class NewWorldClient extends FoodstuffsClient {
  constructor(options = {}) {
    super({ ...options, banner: "newworld" });
  }
}
