import { api } from '../api.js';
import { esc, viewToggleHtml, bindViewToggle, bindProductClicks, getViewMode } from '../lib/utils.js';
import { productCardHtml, productListHtml } from '../components/cards.js';
import { skeletonCards } from '../components/skeleton.js';

export async function renderBrowse(container) {
  container.innerHTML = `<div class="cards-grid">${skeletonCards(12)}</div>`;
  try {
    const stores = await api.stores();
    const retailers = [...new Set(stores.map((s) => s.retailer).filter(Boolean))].sort();
    let searchQuery = '';
    let retailerFilter = '';
    let mode = getViewMode();
    let page = 0;
    const PAGE = 42;

    container.innerHTML = `
      <div class="page-header">
        <div>
          <h2>Browse products</h2>
          <p id="browse-count">&nbsp;</p>
        </div>
        ${viewToggleHtml(mode)}
      </div>
      <div class="filter-bar">
        <input type="text" id="search-input" placeholder="Search products…" aria-label="Search products">
        <select id="retailer-filter" aria-label="Retailer">
          <option value="">All retailers</option>
          ${retailers.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('')}
        </select>
      </div>
      <div id="browse-results" style="transition:opacity .1s"><div class="cards-grid">${skeletonCards(8)}</div></div>
      <div id="browse-pager"></div>`;

    const countEl = container.querySelector('#browse-count');
    const resultsEl = container.querySelector('#browse-results');
    const pagerEl = container.querySelector('#browse-pager');

    let reqId = 0;
    async function refresh() {
      const mine = ++reqId;
      resultsEl.style.opacity = '0.5';
      let data;
      try {
        data = await api.products({
          limit: PAGE,
          offset: page * PAGE,
          retailer: retailerFilter || undefined,
          query: searchQuery || undefined,
        });
      } catch (e) {
        if (mine !== reqId) return;
        resultsEl.style.opacity = '1';
        resultsEl.innerHTML = `<div class="error">Failed to load products: ${esc(e.message || e)}</div>`;
        pagerEl.innerHTML = '';
        return;
      }
      if (mine !== reqId) return;
      const list = data.products || [];
      const total = Number(data.total) || list.length;
      const pages = Math.max(1, Math.ceil(total / PAGE));
      if (page >= pages) { page = Math.max(0, pages - 1); }

      countEl.textContent = `${total.toLocaleString()} products`;
      resultsEl.style.opacity = '1';
      resultsEl.innerHTML = !list.length
        ? '<div class="empty-state"><p>No products match your search.</p></div>'
        : mode === 'list'
          ? `<div class="card list-wrap">${list.map(productListHtml).join('')}</div>`
          : `<div class="cards-grid">${list.map(productCardHtml).join('')}</div>`;

      let pager = '';
      if (pages > 1) {
        pager = '<div class="pagination">';
        pager += `<button type="button" ${page === 0 ? 'disabled' : ''} data-page="${page - 1}">← Prev</button>`;
        for (let i = 0; i < pages; i++) {
          if (pages > 12 && Math.abs(i - page) > 3 && i !== 0 && i !== pages - 1) {
            if (i === 1 || i === pages - 2) pager += '<span class="muted" style="padding:6px">…</span>';
            continue;
          }
          pager += `<button type="button" class="${i === page ? 'active' : ''}" data-page="${i}">${i + 1}</button>`;
        }
        pager += `<button type="button" ${page >= pages - 1 ? 'disabled' : ''} data-page="${page + 1}">Next →</button>`;
        pager += '</div>';
      }
      pagerEl.innerHTML = pager;
      pagerEl.querySelectorAll('[data-page]').forEach((el) => {
        el.addEventListener('click', () => {
          page = Number(el.dataset.page);
          refresh();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        });
      });
      bindProductClicks(resultsEl);
    }

    const searchEl = container.querySelector('#search-input');
    let searchTimer;
    searchEl.addEventListener('input', (e) => {
      searchQuery = e.target.value;
      page = 0;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(refresh, 250);
    });
    container.querySelector('#retailer-filter').addEventListener('change', (e) => {
      retailerFilter = e.target.value;
      page = 0;
      refresh();
    });
    bindViewToggle(container, (m) => {
      mode = m;
      container.querySelectorAll('[data-viewmode]').forEach((btn) => {
        const active = btn.dataset.viewmode === m;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-pressed', String(active));
      });
      refresh();
    });

    await refresh();
  } catch (e) {
    container.innerHTML = `<div class="error">Failed to load products: ${esc(e.message)}</div>`;
  }
}
