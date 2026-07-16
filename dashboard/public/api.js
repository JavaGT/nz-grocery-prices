const BASE = "";

export const api = {
  async feed(params = {}) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ""))
    ).toString();
    const res = await fetch(`${BASE}/api/feed${qs ? "?" + qs : ""}`);
    if (!res.ok) throw new Error(`Feed: ${res.status}`);
    return res.json();
  },

  async products(params = {}) {
    const qs = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null && v !== ""))
    ).toString();
    const res = await fetch(`${BASE}/api/products${qs ? "?" + qs : ""}`);
    if (!res.ok) throw new Error(`Products: ${res.status}`);
    return res.json();
  },

  async productHistory(productId) {
    const res = await fetch(`${BASE}/api/products/${encodeURIComponent(productId)}/history`);
    if (!res.ok) throw new Error(`History: ${res.status}`);
    return res.json();
  },

  async stores() {
    const res = await fetch(`${BASE}/api/stores`);
    if (!res.ok) throw new Error(`Stores: ${res.status}`);
    return res.json();
  },

  async stats() {
    const res = await fetch(`${BASE}/api/stats`);
    if (!res.ok) throw new Error(`Stats: ${res.status}`);
    return res.json();
  },
};