import { el, esc, clear, delegate } from '../utils/dom.js';
import { formatCents, formatRelativeTime, retailerLabel } from '../utils/format.js';
import { createProductCard, createSkeletonCard, createEmptyState, createErrorState } from '../components/card.js';
import { openDetailDialog } from '../components/detail-dialog.js';

export function renderWatchlist(container, api) {
  clear(container);
  container.appendChild(el('div', { className: 'view-loading' }, ...Array(4).fill(null).map(() => createSkeletonCard())));

  let entries = [];

  async function load() {
    try {
      const data = await api.watchlist();
      entries = data || [];
      render();
    } catch (e) {
      if (e.isAuthError) {
        clear(container);
        container.appendChild(createAuthPrompt());
        return;
      }
      clear(container);
      container.appendChild(createErrorState('Could not load watch list.', () => { clear(container); load(); }));
    }
  }

  function render() {
    clear(container);

    container.appendChild(el('h2', { className: 'view-title' }, 'Watch List'));

    if (!entries.length) {
      container.appendChild(createEmptyState('Your watch list is empty', 'Search and add products to keep track of their prices.'));
      return;
    }

    const list = el('div', { className: 'watchlist-list' });
    for (const entry of entries) {
      const item = el('div', { className: 'watchlist-item' });
      const info = el('div', { className: 'watchlist-info' });
      info.appendChild(el('strong', {}, esc(entry.label || entry.targetId)));
      if (entry.targetKind) {
        info.appendChild(el('span', { className: 'watchlist-kind' }, esc(entry.targetKind)));
      }
      if (entry.currentPrice) {
        info.appendChild(el('span', { className: 'watchlist-price' }, formatCents(entry.currentPrice)));
      }
      item.appendChild(info);

      const actions = el('div', { className: 'watchlist-actions' });
      const delBtn = el('button', {
        className: 'btn btn-sm btn-danger',
        onClick: async () => {
          try {
            await api.removeWatch(entry.id);
            entries = entries.filter(e => e.id !== entry.id);
            render();
          } catch {}
        }
      }, 'Remove');
      actions.appendChild(delBtn);
      item.appendChild(actions);

      if (entry.productId) {
        item.addEventListener('click', e => {
          if (e.target.closest('.watchlist-actions')) return;
          openDetailDialog({
            productId: entry.productId,
            productName: entry.label,
            retailer: entry.retailer,
            storeName: entry.storeName,
            currentCents: entry.currentPrice,
            regularCents: entry.regularPrice,
            observedAt: entry.updatedAt,
          }, api);
        });
        item.classList.add('clickable');
        item.setAttribute('tabindex', '0');
        item.setAttribute('role', 'button');
      }

      list.appendChild(item);
    }
    container.appendChild(list);
  }

  load();
}

function createAuthPrompt() {
  const wrap = el('div', { className: 'auth-prompt' });
  wrap.appendChild(el('h2', { className: 'view-title' }, 'Watch List'));
  wrap.appendChild(el('p', {}, 'Sign in or create an account to save products to your watch list.'));
  wrap.appendChild(el('a', { className: 'btn btn-primary', href: '#settings' }, 'Go to Settings'));
  return wrap;
}
