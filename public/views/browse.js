import { el, esc, clear, delegate, qs } from '../utils/dom.js';
import { formatCents, formatShortDate, formatRelativeTime, retailerLabel } from '../utils/format.js';
import { createProductCard, createSkeletonCard, createEmptyState, createErrorState } from '../components/card.js';
import { openDetailDialog } from '../components/detail-dialog.js';

export function renderBrowse(container, api, params) {
  clear(container);
  container.appendChild(el('div', { className: 'view-loading' }, ...Array(8).fill(null).map(() => createSkeletonCard())));

  let state = {
    query: params?.q || '',
    retailer: params?.retailer || '',
    category: params?.category || '',
    limit: 42,
    offset: 0,
    data: null,
    loading: false,
  };

  function pushState() {
    const q = new URLSearchParams();
    if (state.query) q.set('q', state.query);
    if (state.retailer) q.set('retailer', state.retailer);
    if (state.category) q.set('category', state.category);
    const hash = `browse${q.toString() ? '?' + q.toString() : ''}`;
    if (location.hash !== '#' + hash) {
      history.replaceState(null, '', '#' + hash);
    }
  }

  async function load(append = false) {
    if (state.loading) return;
    state.loading = true;

    try {
      const params = { limit: state.limit, offset: state.offset };
      if (state.query) params.query = state.query;
      if (state.retailer) params.retailer = state.retailer;
      if (state.category) params.category = state.category;

      const data = await api.products(params);

      if (append && state.data) {
        state.data = {
          products: [...state.data.products, ...data.products],
          total: data.total,
          limit: data.limit,
          offset: data.offset,
        };
      } else {
        state.data = data;
      }
      render(append);
    } catch (e) {
      if (!append) {
        clear(container);
        container.appendChild(createErrorState('Could not load products.', () => { clear(container); load(); }));
      }
    } finally {
      state.loading = false;
    }
  }

  function render(append = false) {
    if (!append) {
      clear(container);

      const header = el('div', { className: 'browse-header' });
      const searchForm = el('form', { className: 'browse-search', onSubmit: e => { e.preventDefault(); state.offset = 0; load(); pushState(); } });
      const input = el('input', {
        name: 'q', 'aria-label': 'Search products',
        placeholder: 'Search products\u2026',
        maxlength: '200',
        value: state.query,
        onInput: () => { /* debounce handled below */ }
      });
      searchForm.appendChild(input);
      searchForm.appendChild(el('button', { type: 'submit' }, 'Search'));
      header.appendChild(searchForm);

      const retailerSelect = el('select', {
        'aria-label': 'Filter by retailer',
        onChange: e => { state.retailer = e.target.value; state.offset = 0; load(); pushState(); }
      });
      retailerSelect.appendChild(el('option', { value: '' }, 'All retailers'));
      header.appendChild(retailerSelect);
      container.appendChild(header);

      const resultsInfo = el('div', { className: 'results-info' });
      container.appendChild(resultsInfo);

      const gridWrap = el('div', { className: 'browse-results' });
      container.appendChild(gridWrap);
      container.appendChild(el('div', { className: 'browse-footer' }));
    }

    const resultsInfo = qs('.results-info', container);
    const gridWrap = qs('.browse-results', container);
    const footer = qs('.browse-footer', container);

    if (state.data) {
      const total = state.data.total || 0;
      const loaded = state.data.products?.length || 0;
      resultsInfo.innerHTML = '';
      if (state.query) {
        if (total === 0) {
          resultsInfo.appendChild(el('span', { className: 'quiet' }, `No products found for \u201c${esc(state.query)}\u201d`));
        } else {
          resultsInfo.appendChild(el('span', {}, `\u201c${esc(state.query)}\u201d \u2014 ${total} product${total !== 1 ? 's' : ''}`));
        }
      } else if (total > 0) {
        resultsInfo.appendChild(el('span', { className: 'quiet' }, `${total} products`));
      }

      if (!append) gridWrap.innerHTML = '';
      for (const product of state.data.products || []) {
        gridWrap.appendChild(createProductCard({
          productId: product.id,
          productName: product.name,
          retailer: product.retailer,
          storeName: product.storeName || product.retailer,
          currentCents: product.currentCents,
          regularCents: product.regularCents,
          imageUrl: product.imageUrl,
          observedAt: product.updatedAt || product.lastSeenAt,
          sourceLabel: 'Live collection',
        }, {
          onClick: (d) => openDetailDialog(d, api),
        }));
      }

      if (total === 0 && !state.query) {
        gridWrap.innerHTML = '';
        gridWrap.appendChild(createEmptyState('No products yet', 'Products will appear once prices are collected.'));
      }

      footer.innerHTML = '';
      if (loaded < total) {
        if (state.loading) {
          for (let i = 0; i < 4; i++) footer.appendChild(createSkeletonCard());
        } else {
          const loadMore = el('button', {
            className: 'btn btn-outline load-more',
            onClick: () => { state.offset = loaded; load(true); }
          }, `Show more (${loaded} of ${total})`);
          footer.appendChild(loadMore);
        }
      }
    }

    pushState();
  }

  if (state.query || state.retailer || state.category) {
    load();
  } else {
    load();
  }

  const input = qs('.browse-search input', container);
  if (input) {
    let debounceTimer;
    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        state.query = input.value;
        state.offset = 0;
        load();
        pushState();
      }, 300);
    });
  }

  return {
    updateParams(newParams) {
      state.query = newParams.q || '';
      state.retailer = newParams.retailer || '';
      state.category = newParams.category || '';
      state.offset = 0;
      load();
    }
  };
}
