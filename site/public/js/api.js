async function apiGet(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

const responseCache = new Map();

function cachedGet(path) {
  if (!responseCache.has(path)) {
    const p = apiGet(path).catch((e) => {
      responseCache.delete(path);
      throw e;
    });
    responseCache.set(path, p);
  }
  return responseCache.get(path);
}

export const api = {
  deals: () => cachedGet('/api/deals'),
  products: (params = {}) => {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== '')),
    ).toString();
    return apiGet(`/api/products${qs ? `?${qs}` : ''}`);
  },
  productHistory: (id) => apiGet(`/api/products/${encodeURIComponent(id)}/history`),
  stores: async () => {
    const body = await cachedGet('/api/stores');
    return body.stores || body;
  },
  stats: () => cachedGet('/api/stats'),
};
