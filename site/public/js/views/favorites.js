import { esc, viewToggleHtml, bindViewToggle, bindProductClicks, getViewMode } from '../lib/utils.js';
import { getFavorites } from '../lib/favorites.js';
import { api } from '../api.js';
import { productCardHtml, productListHtml } from '../components/cards.js';

export async function renderFavorites(container) {
  container.innerHTML = '<div class="loading">Loading favorites…</div>';
  try {
    const favs = getFavorites();
    if (!favs.length) {
      container.innerHTML = `
        <div class="page-header"><div><h2>Favorites</h2></div></div>
        <div class="empty-state"><p>No favorites saved yet.</p><p class="muted" style="margin-top:6px">Open a product and click Save.</p></div>`;
      return;
    }
    const data = await api.products({ limit: 500 });
    const products = (data.products || []).filter((p) => favs.includes(p.id));
    let mode = getViewMode();

    function paint() {
      const body = !products.length
        ? '<div class="empty-state"><p>Saved products not found in the current data.</p></div>'
        : mode === 'list'
          ? `<div class="card list-wrap">${products.map(productListHtml).join('')}</div>`
          : `<div class="cards-grid">${products.map(productCardHtml).join('')}</div>`;
      container.innerHTML = `
        <div class="page-header">
          <div><h2>Favorites</h2><p>${products.length} saved</p></div>
          ${viewToggleHtml(mode)}
        </div>
        ${body}`;
      bindViewToggle(container, (m) => { mode = m; paint(); });
      bindProductClicks(container);
    }
    paint();
  } catch (e) {
    container.innerHTML = `<div class="error">${esc(e.message)}</div>`;
  }
}
