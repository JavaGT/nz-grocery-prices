import { el } from './utils/dom.js';

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.data = data;
    this.isAuthError = status === 401;
  }
}

const BASE = '';
const inflight = new Map();

// Small TTL cache for GET requests: switching views re-mounts each view, which
// today refetches identical payloads. 30s keeps data fresh enough for a price
// archive that updates nightly; any successful mutation clears it so user
// actions (watch/saved/prefs/auth) are never served from stale cache.
const GET_CACHE_TTL_MS = 30_000;
const getCache = new Map(); // url -> { at, data }
// Hard bound on retained GET payloads (product details + 200-point histories
// are tens of KB each). Without it a long browse session accumulates one
// entry per visited URL until the next mutation. Eviction only REMOVES
// entries — a miss refetches — so cache correctness is unchanged.
const GET_CACHE_MAX_ENTRIES = 100;

export { ApiError };

function cacheGet(url) {
  const hit = getCache.get(url);
  if (hit && Date.now() - hit.at < GET_CACHE_TTL_MS) return hit.data;
  if (hit) getCache.delete(url);
  return undefined;
}

function cacheSet(url, data) {
  // Clone on write AND read so no caller can mutate cached state.
  getCache.set(url, { at: Date.now(), data: structuredClone(data) });
  // Drop expired entries first (they are dead weight), then evict the
  // oldest-inserted survivors while over the cap (Map iteration is insertion
  // order; re-insertion on read refreshes nothing, so this is FIFO).
  const now = Date.now();
  for (const [u, hit] of getCache) {
    if (now - hit.at >= GET_CACHE_TTL_MS) getCache.delete(u);
  }
  while (getCache.size > GET_CACHE_MAX_ENTRIES) {
    getCache.delete(getCache.keys().next().value);
  }
}

function cacheClear() {
  getCache.clear();
}

function buildURL(path, params) {
  if (!params) return `${BASE}${path}`;
  const qs = Object.entries(params)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${BASE}${path}${qs ? '?' + qs : ''}`;
}

async function request(path, opts = {}) {
  const { body, params, headers, method = 'GET' } = opts;

  const url = buildURL(path, params);

  if (method === 'GET' && !opts.signal) {
    const cached = cacheGet(url);
    if (cached !== undefined) return structuredClone(cached);
    // Share an identical in-flight GET instead of aborting and refiring it.
    const running = inflight.get(url);
    if (running) return running;
  }

  const controller = new AbortController();
  const signal = opts.signal ? anySignal([opts.signal, controller.signal]) : controller.signal;
  const promise = (async () => {
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json', ...headers } : headers,
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'include',
        signal,
      });

      if (!res.ok) {
        if (res.status === 401) {
          window.dispatchEvent(new CustomEvent('auth:required'));
        }
        let data = null;
        try { data = await res.json(); } catch {}
        throw new ApiError(res.statusText, res.status, data);
      }

      return res.status === 204 ? null : await res.json();
    } finally {
      if (inflight.get(url) === controller || inflight.get(url) === promise) {
        inflight.delete(url);
      }
    }
  })();

  if (method === 'GET' && !opts.signal) {
    inflight.set(url, promise);
  } else {
    inflight.set(url, controller);
  }

  try {
    const data = await promise;
    if (method === 'GET') {
      cacheSet(url, data);
    } else {
      // Mutations (and auth changes) invalidate all cached reads.
      cacheClear();
    }
    return data;
  } catch (err) {
    if (method !== 'GET') cacheClear();
    throw err;
  }
}

// Test/diagnostic hook: drop all cached GET responses.
function clearCache() {
  cacheClear();
}

function anySignal(signals) {
  const controller = new AbortController();
  for (const sig of signals) {
    if (sig.aborted) { controller.abort(sig.reason); return controller.signal; }
    sig.addEventListener('abort', () => controller.abort(sig.reason), { once: true });
  }
  return controller.signal;
}

export const api = {
  deals(params) { return request('/api/deals', { params }); },
  products(params) { return request('/api/products', { params }); },
  product(id) { return request(`/api/products/${encodeURIComponent(id)}`); },
  productHistory(id) { return request(`/api/products/${encodeURIComponent(id)}/history`); },
  stores() { return request('/api/stores'); },
  suggestions(q) { return request('/api/search/suggestions', { params: { query: q } }); },
  health() { return request('/api/health'); },

  watchlist() { return request('/api/watch-list'); },
  addWatch(entry) { return request('/api/watch-list', { method: 'POST', body: entry }); },
  removeWatch(id) { return request(`/api/watch-list/${encodeURIComponent(id)}`, { method: 'DELETE' }); },

  preferredStores() { return request('/api/preferred-stores'); },
  setPreferredStore(data) { return request('/api/preferred-stores', { method: 'POST', body: data }); },
  removePreferredStore(id) { return request(`/api/preferred-stores/${encodeURIComponent(id)}`, { method: 'DELETE' }); },

  savedSearches() { return request('/api/saved-searches'); },
  saveSearch(data) { return request('/api/saved-searches', { method: 'POST', body: data }); },
  deleteSearch(id) { return request(`/api/saved-searches/${encodeURIComponent(id)}`, { method: 'DELETE' }); },

  newProducts() { return request('/api/new-products'); },

  register(data) { return request('/api/auth/register', { method: 'POST', body: data }); },
  login(data) { return request('/api/auth/login', { method: 'POST', body: data }); },
  logout() { return request('/api/auth/logout', { method: 'POST' }); },

  setStorePrefs(data) { return request('/api/preferred-stores', { method: 'POST', body: data }); },

  clearCache,
};
