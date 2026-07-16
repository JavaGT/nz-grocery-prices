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

export { ApiError };

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

  const key = `${method}:${url}`;
  if (inflight.has(key)) {
    inflight.get(key).abort();
  }

  const controller = new AbortController();
  const signal = opts.signal ? anySignal([opts.signal, controller.signal]) : controller.signal;
  inflight.set(key, controller);

  try {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
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
    if (inflight.get(key) === controller) {
      inflight.delete(key);
    }
  }
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
};
