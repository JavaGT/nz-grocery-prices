import { el, esc, clear } from '../utils/dom.js';
import { formatDate } from '../utils/format.js';
import { createSkeletonCard, createEmptyState, createErrorState } from '../components/card.js';

export function renderSaved(container, api) {
  clear(container);
  container.appendChild(el('div', { className: 'view-loading' }, ...Array(3).fill(null).map(() => createSkeletonCard())));

  let searches = [];

  async function load() {
    try {
      const data = await api.savedSearches();
      searches = data || [];
      render();
    } catch (e) {
      if (e.isAuthError) {
        clear(container);
        container.appendChild(createAuthPrompt());
        return;
      }
      clear(container);
      container.appendChild(createErrorState('Could not load saved searches.', () => { clear(container); load(); }));
    }
  }

  function render() {
    clear(container);

    container.appendChild(el('h2', { className: 'view-title' }, 'Saved Searches'));

    const form = el('form', {
      className: 'save-search-form',
      onSubmit: async e => {
        e.preventDefault();
        const name = e.target.name.value?.trim();
        const query = e.target.query.value?.trim();
        if (!name || !query) return;
        try {
          await api.saveSearch({ name, queryText: query });
          e.target.reset();
          load();
        } catch (err) {
          const msg = qs('.save-search-error', form);
          if (msg) msg.textContent = err.data?.error || 'Could not save search.';
        }
      }
    });

    form.innerHTML = `
      <input name="name" placeholder="Search name" maxlength="100" required aria-label="Search name">
      <input name="query" placeholder="Search query" maxlength="200" required aria-label="Search query">
      <button type="submit" class="btn btn-primary">Save</button>
      <div class="save-search-error" style="color:var(--orange);font-size:13px;margin-top:4px"></div>
    `;
    container.appendChild(form);

    if (!searches.length) {
      container.appendChild(createEmptyState('No saved searches yet', 'Save a search to quickly find products later.'));
      return;
    }

    const list = el('div', { className: 'saved-list' });
    for (const s of searches) {
      const item = el('div', { className: 'saved-item' });
      const info = el('div', { className: 'saved-info' });
      info.appendChild(el('strong', {}, esc(s.name)));
      info.appendChild(el('span', { className: 'saved-query' }, esc(s.queryText)));
      if (s.createdAt) {
        info.appendChild(el('span', { className: 'saved-date' }, `Saved ${formatDate(s.createdAt)}`));
      }
      item.appendChild(info);

      const actions = el('div', { className: 'saved-actions' });
      const runBtn = el('button', {
        className: 'btn btn-sm btn-outline',
        onClick: () => { location.hash = `browse?q=${encodeURIComponent(s.queryText)}`; }
      }, 'Run');
      actions.appendChild(runBtn);

      const delBtn = el('button', {
        className: 'btn btn-sm btn-danger',
        onClick: async () => {
          try {
            await api.deleteSearch(s.id);
            searches = searches.filter(x => x.id !== s.id);
            render();
          } catch {}
        }
      }, 'Delete');
      actions.appendChild(delBtn);
      item.appendChild(actions);
      list.appendChild(item);
    }
    container.appendChild(list);
  }

  load();
}

function qs(sel, ctx) { return ctx?.querySelector(sel); }

function createAuthPrompt() {
  const wrap = el('div', { className: 'auth-prompt' });
  wrap.appendChild(el('h2', { className: 'view-title' }, 'Saved Searches'));
  wrap.appendChild(el('p', {}, 'Sign in to save and manage your searches.'));
  wrap.appendChild(el('a', { className: 'btn btn-primary', href: '#settings' }, 'Go to Settings'));
  return wrap;
}
