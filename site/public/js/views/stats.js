import { esc, $c, fmtDate, badgeClass } from '../lib/utils.js';
import { api } from '../api.js';

export async function renderStats(container) {
  container.innerHTML = '<div class="loading">Loading stats…</div>';
  try {
    const stats = await api.stats();
    const { retailers = [], stores = [], totalProducts, totalObservations, totalStores, dateRange } = stats;
    container.innerHTML = `
      <div class="page-header"><div><h2>Stats</h2><p>Overview of collected price data</p></div></div>
      <div class="stats-grid">
        <div class="card stat-card"><div class="stat-value">${Number(totalProducts || 0).toLocaleString()}</div><div class="stat-label">Products tracked</div></div>
        <div class="card stat-card"><div class="stat-value">${totalStores || 0}</div><div class="stat-label">Stores</div></div>
        <div class="card stat-card"><div class="stat-value">${Number(totalObservations || 0).toLocaleString()}</div><div class="stat-label">Price records</div></div>
        <div class="card stat-card"><div class="stat-value">${retailers.length}</div><div class="stat-label">Retailers</div></div>
      </div>
      <div class="card">
        <h3 style="margin-bottom:12px;font-size:16px">Retailers</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          ${retailers.map((r) => `<span class="${badgeClass(r)}" style="font-size:13px;padding:4px 12px">${esc(r)}</span>`).join('')}
        </div>
      </div>
      <div class="card">
        <h3 style="margin-bottom:12px;font-size:16px">Date range</h3>
        <p class="muted">${dateRange?.earliest ? fmtDate(dateRange.earliest, true) : '—'} → ${dateRange?.latest ? fmtDate(dateRange.latest, true) : '—'}</p>
      </div>
      <div class="card" style="padding:0;overflow-x:auto">
        <table>
          <thead><tr><th>Store</th><th>Retailer</th><th>Region</th><th>Address</th></tr></thead>
          <tbody>
            ${stores.map((s) => `
              <tr>
                <td><strong>${esc(s.name || s.id)}</strong></td>
                <td><span class="${badgeClass(s.retailer)}">${esc(s.retailer)}</span></td>
                <td>${s.region ? esc(s.region) : '—'}</td>
                <td class="muted">${s.address ? esc(s.address) : '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;
  } catch (e) {
    container.innerHTML = `<div class="error">Failed to load stats: ${esc(e.message)}</div>`;
  }
}
