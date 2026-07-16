import { api } from "../api.js";

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

export async function renderStats(container) {
  container.innerHTML = `<div class="loading">Loading stats…</div>`;

  try {
    const stats = await api.stats();
    const { retailers, stores, totalProducts, totalObservations, totalStores, dateRange } = stats;

    let html = `
      <div class="page-header">
        <h2>Stats</h2>
        <p>Overview of all collected price data</p>
      </div>
      <div class="stats-grid">
        <div class="card stat-card">
          <div class="stat-value">${totalProducts.toLocaleString()}</div>
          <div class="stat-label">Products tracked</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value">${totalStores}</div>
          <div class="stat-label">Stores</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value">${totalObservations.toLocaleString()}</div>
          <div class="stat-label">Price records</div>
        </div>
        <div class="card stat-card">
          <div class="stat-value">${retailers.length}</div>
          <div class="stat-label">Retailers</div>
        </div>
      </div>
      <div class="card">
        <h3 style="margin-bottom:12px;font-size:16px">Retailers</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${retailers.map(r => `<span class="badge badge-${r}" style="font-size:13px;padding:4px 12px">${r}</span>`).join("")}
        </div>
      </div>
      <div class="card">
        <h3 style="margin-bottom:12px;font-size:16px">Date range</h3>
        <p style="font-size:14px;color:#666">${dateRange?.earliest ? new Date(dateRange.earliest).toLocaleDateString("en-NZ") : "—"} → ${dateRange?.latest ? new Date(dateRange.latest).toLocaleDateString("en-NZ") : "—"}</p>
      </div>
      <div class="card" style="padding:0;overflow-x:auto">
        <table><thead><tr><th>Store</th><th>Retailer</th><th>Region</th><th>Address</th></tr></thead><tbody>
          ${(stores || []).map(s => `
            <tr>
              <td><span style="font-weight:500">${esc(s.name || s.id)}</span></td>
              <td><span class="badge badge-${s.retailer}">${s.retailer}</span></td>
              <td>${s.region ? esc(s.region) : "—"}</td>
              <td style="font-size:13px;color:#888">${s.address ? esc(s.address) : "—"}</td>
            </tr>
          `).join("")}
        </tbody></table>
      </div>
    `;

    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div class="page-header"><h2>Stats</h2></div><div class="error">Failed to load stats: ${e.message}</div>`;
  }
}