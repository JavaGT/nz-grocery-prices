import { esc, $c, fmtDate, badgeClass, imgHtml, initial } from '../lib/utils.js';
import { api } from '../api.js';
import { addFavorite, removeFavorite, isFavorite } from '../lib/favorites.js';
import { renderPriceChart } from '../lib/charts.js';

export async function renderProduct(container, productId) {
  container.innerHTML = '<div class="loading">Loading product…</div>';
  try {
    const data = await api.productHistory(productId);
    const history = data.history || data.offers || [];
    if (!history.length) {
      container.innerHTML = '<div class="empty-state"><p>Product not found.</p></div>';
      return;
    }
    const latest = history[history.length - 1];
    const p = data.product || latest.product || {};
    const store = data.store || latest.store || {};
    const imageUrl = data.imageUrl || p.images && (
      typeof p.images === 'string' ? p.images
        : p.images.primary || p.images['400'] || p.images.big
          || Object.values(p.images).find((v) => typeof v === 'string')
    );
    let fav = isFavorite(productId);

    container.innerHTML = `
      <button type="button" class="back-link" id="back-btn">← Back</button>
      <div class="card detail-hero">
        <div class="detail-img">${imgHtml(imageUrl, p.name)}</div>
        <div>
          <div class="page-header" style="margin:0 0 12px">
            <div>
              <h2>${esc(p.name || productId)}</h2>
              ${p.brand ? `<p>${esc(p.brand)}</p>` : ''}
            </div>
          </div>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;align-items:center">
            <button type="button" class="btn ${fav ? 'btn-danger' : 'btn-outline'} btn-sm" id="fav-btn">${fav ? '♥ Saved' : '♡ Save'}</button>
            ${store.retailer ? `<span class="${badgeClass(store.retailer)}">${esc(store.retailer)}</span>` : ''}
            ${latest.price ? `<span class="price-current">${$c(latest.price.promoCents ?? latest.price.memberCents ?? latest.price.regularCents ?? latest.price.currentCents)}</span>` : ''}
          </div>
          <dl class="info-grid">
            <dt>Product ID</dt><dd style="font-family:var(--font-mono);font-size:12px">${esc(productId)}</dd>
            ${p.gtin ? `<dt>GTIN</dt><dd>${esc(p.gtin)}</dd>` : ''}
            ${p.categories?.length ? `<dt>Categories</dt><dd>${p.categories.map((c) => esc(c)).join(' · ')}</dd>` : ''}
            ${store.name ? `<dt>Store</dt><dd>${esc(store.name)}${store.address ? ` — ${esc(store.address)}` : ''}</dd>` : ''}
            <dt>Observations</dt><dd>${history.length} price records</dd>
          </dl>
        </div>
      </div>
      <h3 class="section-title">Price history</h3>
      <div class="card" id="chart-container"></div>
      <div class="card" style="padding:0;overflow-x:auto">
        <table>
          <thead><tr><th>Date</th><th>Store</th><th>Regular</th><th>Promo</th><th>Member</th></tr></thead>
          <tbody>
            ${[...history].reverse().map((o) => `
              <tr>
                <td>${fmtDate(o.observedAt, true)}</td>
                <td>${esc(o.store?.name || '—')}</td>
                <td>${$c(o.price?.regularCents)}</td>
                <td>${o.price?.promoCents != null ? $c(o.price.promoCents) : '—'}</td>
                <td>${o.price?.memberCents != null ? $c(o.price.memberCents) : '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`;

    document.getElementById('back-btn').addEventListener('click', () => {
      if (window.history.length > 1) window.history.back();
      else location.hash = 'browse';
    });
    document.getElementById('fav-btn').addEventListener('click', () => {
      if (isFavorite(productId)) {
        removeFavorite(productId);
        fav = false;
      } else {
        addFavorite(productId);
        fav = true;
      }
      const btn = document.getElementById('fav-btn');
      btn.textContent = fav ? '♥ Saved' : '♡ Save';
      btn.className = `btn ${fav ? 'btn-danger' : 'btn-outline'} btn-sm`;
    });
    renderPriceChart(document.getElementById('chart-container'), history);
  } catch (e) {
    container.innerHTML = `<div class="error">Failed to load product: ${esc(e.message)}</div>`;
  }
}
