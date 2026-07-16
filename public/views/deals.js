import { el, esc, clear, delegate, qs } from '../utils/dom.js';
import { formatCents, formatDropPercent, formatRelativeTime, retailerLabel, freshnessLevel, retailerColor } from '../utils/format.js';
import { createProductCard, createSkeletonCard, createEmptyState, createErrorState, createFreshnessBanner } from '../components/card.js';
import { openDetailDialog } from '../components/detail-dialog.js';

export function renderDeals(container, api) {
  clear(container);
  container.appendChild(el('div', { className: 'view-loading' }, ...Array(6).fill(null).map(() => createSkeletonCard())));

  let state = { filter: 'all', retailer: '', deals: [], advertised: [], freshness: null, stale: false, tiers: null };

  async function load() {
    try {
      const data = await api.deals({ filter: state.filter, limit: 120, retailer: state.retailer || undefined });
      state.deals = data.historyBacked || [];
      state.advertised = data.advertised || [];
      state.freshness = data.archiveFreshness || null;
      state.stale = data.stale || false;
      state.tiers = data.tiers || null;
      render();
    } catch (e) {
      clear(container);
      container.appendChild(createErrorState('Could not load deals.', () => { clear(container); load(); }));
    }
  }

  function render() {
    clear(container);

    const freshnessBanner = createFreshnessBanner(state.freshness);
    if (freshnessBanner) container.appendChild(freshnessBanner);

    const hero = el('section', { className: 'deals-hero' });
    hero.appendChild(el('div', { className: 'eyebrow' }, 'Your selected stores'));
    hero.appendChild(el('h1', {}, 'Find a deal you can feel good about.'));
    const searchForm = el('form', { className: 'hero-search', onSubmit: e => { e.preventDefault(); const v = qs('[name=q]', searchForm)?.value; if (v) location.hash = `browse?q=${encodeURIComponent(v)}`; } });
    searchForm.appendChild(el('input', { name: 'q', 'aria-label': 'Search products', placeholder: 'Try \u201ccheap butter\u201d or \u201cWeet-Bix\u201d', maxlength: '200' }));
    searchForm.appendChild(el('button', { type: 'submit' }, 'Search'));
    hero.appendChild(searchForm);
    container.appendChild(hero);

    const filterBar = el('div', { className: 'filter-bar' });
    const filters = [
      { value: 'all', label: 'Best deals' },
      { value: 'history-backed', label: 'Price drops' },
      { value: 'advertised', label: 'On special' },
    ];
    for (const f of filters) {
      const btn = el('button', {
        className: `filter ${state.filter === f.value ? 'selected' : ''}`,
        onClick: () => { state.filter = f.value; load(); }
      }, f.label);
      filterBar.appendChild(btn);
    }
    container.appendChild(filterBar);

    const total = state.deals.length + state.advertised.length;

    const sectionHead = el('div', { className: 'section-head' });
    sectionHead.appendChild(el('h2', {}, total > 0 ? 'Best deals right now' : 'No current deals'));
    if (total > 0) {
      const quiet = el('span', { className: 'quiet' }, state.deals.length > 0 ? 'History-backed savings at your stores.' : 'Current advertised specials.');
      sectionHead.appendChild(quiet);
    }
    container.appendChild(sectionHead);

    if (total === 0) {
      if (state.stale) {
        container.appendChild(createEmptyState('No current deals \u2014 collection in progress', 'New deals will appear once prices are collected.'));
      } else {
        container.appendChild(createEmptyState('No deals match your filters', 'Try adjusting the filters or check back later.'));
      }
      return;
    }

    if (state.tiers && (state.tiers.watchPreferred > 0 || state.tiers.watchOther > 0)) {
      renderTiered();
      return;
    }

    if (state.deals.length > 0) {
      const subhead = el('div', { className: 'section-subhead' },
        el('span', { className: 'quiet' }, `History-backed deals \u2022 ${state.deals.length}`)
      );
      container.appendChild(subhead);
      const grid = el('div', { className: 'card-grid' });
      for (const deal of state.deals) {
        grid.appendChild(createProductCard(deal, {
          onClick: (d) => openDetailDialog(d, api),
        }));
      }
      container.appendChild(grid);
    }

    if (state.advertised.length > 0) {
      const subhead = el('div', { className: 'section-subhead' },
        el('span', { className: 'quiet' }, `Current specials \u2022 ${state.advertised.length}`)
      );
      container.appendChild(subhead);
      const grid = el('div', { className: 'card-grid' });
      for (const deal of state.advertised) {
        grid.appendChild(createProductCard(deal, {
          onClick: (d) => openDetailDialog(d, api),
        }));
      }
      container.appendChild(grid);
    }
  }

  function renderTiered() {
    const allDeals = [...state.deals, ...state.advertised];
    const tierLabels = {
      'watch-preferred': 'In your watch list \u2022 at your stores',
      'watch-other': 'In your watch list \u2022 other stores',
      'all': 'All deals',
    };
    const tierOrder = ['watch-preferred', 'watch-other', 'all'];
    for (const tier of tierOrder) {
      const tierDeals = allDeals.filter(d => d.tier === tier);
      if (tierDeals.length === 0) continue;
      const subhead = el('div', { className: 'section-subhead' },
        el('span', { className: 'quiet' }, `${tierLabels[tier]} \u2022 ${tierDeals.length}`)
      );
      container.appendChild(subhead);
      const grid = el('div', { className: 'card-grid' });
      for (const deal of tierDeals) {
        grid.appendChild(createProductCard(deal, {
          onClick: (d) => openDetailDialog(d, api),
        }));
      }
      container.appendChild(grid);
    }
  }

  load();
}
