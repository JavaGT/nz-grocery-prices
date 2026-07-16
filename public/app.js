import { api } from './api.js';
import { el } from './utils/dom.js';
import { renderDeals } from './views/deals.js';
import { renderBrowse } from './views/browse.js';
import { renderWatchlist } from './views/watchlist.js';
import { renderSaved } from './views/saved.js';
import { renderSettings } from './views/settings.js';

let currentCleanup = null;

const NAV_ITEMS = [
  { id: 'deals', label: 'Deals', icon: '\u2605' },
  { id: 'browse', label: 'Browse', icon: '\u2315' },
  { id: 'watchlist', label: 'Watch', icon: '\u25C9' },
  { id: 'saved', label: 'Saved', icon: '\u2606' },
  { id: 'settings', label: 'Settings', icon: '\u2699' },
];

function init() {
  const sidebar = document.getElementById('sidebar');
  const bottomNav = document.getElementById('bottom-nav');
  const main = document.getElementById('main-content');

  const logo = document.createElement('div');
  logo.className = 'sidebar-logo';
  logo.innerHTML = 'price<span class="logo-dot"></span>minder';
  sidebar.appendChild(logo);

  for (const item of NAV_ITEMS) {
    const a = el('a', {
      className: 'nav-link',
      href: `#${item.id}`,
      dataset: { view: item.id },
      'aria-current': 'page',
    });
    a.innerHTML = `<span class="nav-icon">${item.icon}</span><span class="nav-label">${item.label}</span>`;
    sidebar.appendChild(a);

    const b = el('button', {
      className: 'bnav-btn',
      dataset: { view: item.id },
      'aria-label': item.label,
    });
    b.innerHTML = `<span class="bnav-icon">${item.icon}</span><span class="bnav-label">${item.label}</span>`;
    bottomNav.appendChild(b);
  }

  window.addEventListener('hashchange', () => route(main));
  window.addEventListener('auth:required', () => {
    if (location.hash !== '#settings') {
      location.hash = 'settings';
    }
  });

  route(main);
}

function route(main) {
  const hash = location.hash.slice(1) || 'deals';
  const [viewName, hashRest] = hash.split('?');
  const params = Object.fromEntries(new URLSearchParams(hashRest || ''));

  if (currentCleanup && typeof currentCleanup === 'function') {
    currentCleanup();
    currentCleanup = null;
  }

  document.querySelectorAll('.nav-link').forEach(link => {
    link.classList.toggle('active', link.dataset.view === viewName);
  });
  document.querySelectorAll('.bnav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === viewName);
  });

  switch (viewName) {
    case 'deals':
      renderDeals(main, api);
      break;
    case 'browse':
      renderBrowse(main, api, params);
      break;
    case 'watchlist':
      renderWatchlist(main, api);
      break;
    case 'saved':
      renderSaved(main, api);
      break;
    case 'settings':
      renderSettings(main, api);
      break;
    default:
      location.hash = 'deals';
  }
}

document.addEventListener('DOMContentLoaded', init);
