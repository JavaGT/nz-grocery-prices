import { api } from '../api.js';
import { esc, viewToggleHtml, bindViewToggle, bindProductClicks, getViewMode } from '../lib/utils.js';
import { dealCardHtml, dealListHtml } from '../components/cards.js';
import { skeletonCards } from '../components/skeleton.js';

export async function renderDeals(container) {
  container.innerHTML = `<div class="cards-grid">${skeletonCards(12)}</div>`;
  try {
    const [feed, stores] = await Promise.all([api.deals(), api.stores()]);
    const sales = feed.historyBacked || feed.sales || [];
    const ongoing = feed.advertised || feed.ongoingSales || [];
    let storeFilter = '';
    let mode = getViewMode();

    function paint() {
      const s1 = storeFilter ? sales.filter((x) => x.storeId === storeFilter) : sales;
      const s2 = storeFilter ? ongoing.filter((x) => x.storeId === storeFilter) : ongoing;
      const renderItems = (items) => mode === 'list'
        ? `<div class="card list-wrap">${items.map(dealListHtml).join('')}</div>`
        : `<div class="cards-grid">${items.map(dealCardHtml).join('')}</div>`;

      container.innerHTML = `
        <div class="page-header">
          <div>
            <h2>Deals</h2>
            <p>${s1.length} price drops · ${s2.length} promotions</p>
          </div>
          ${viewToggleHtml(mode)}
        </div>
        <div class="filter-bar">
          <select id="deals-filter">
            <option value="">All stores</option>
            ${stores.map((s) => `<option value="${esc(s.id)}"${s.id === storeFilter ? ' selected' : ''}>${esc(s.name)}</option>`).join('')}
          </select>
        </div>
        ${s1.length ? `<h3 class="section-title">Price drops</h3>${renderItems(s1)}` : ''}
        ${s2.length ? `<h3 class="section-title">Current promotions</h3>${renderItems(s2)}` : ''}
        ${!s1.length && !s2.length ? '<div class="empty-state"><p>No deals to show.</p></div>' : ''}
      `;
      document.getElementById('deals-filter').addEventListener('change', (e) => {
        storeFilter = e.target.value;
        paint();
      });
      bindViewToggle(container, (m) => { mode = m; paint(); });
      bindProductClicks(container);
    }
    paint();
  } catch (e) {
    container.innerHTML = `<div class="error">Failed to load deals: ${esc(e.message)}</div>`;
  }
}
