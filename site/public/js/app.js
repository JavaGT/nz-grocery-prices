import { initTheme, getThemeIcon, toggleTheme, getTheme } from './lib/theme.js';
import { renderDeals } from './views/deals.js';
import { renderBrowse } from './views/browse.js';
import { renderFavorites } from './views/favorites.js';
import { renderStats } from './views/stats.js';
import { renderProduct } from './views/product.js';

const main = document.getElementById('main-content');
const sidebar = document.querySelector('.sidebar');
const hamburgerBtn = document.getElementById('hamburger-btn');
const sidebarOverlay = document.getElementById('sidebar-overlay');
const themeToggle = document.getElementById('theme-toggle');

// --- Theme ---
initTheme();
if (themeToggle) {
  themeToggle.addEventListener('click', () => {
    const next = toggleTheme();
    themeToggle.textContent = `${getThemeIcon(next)} ${next === 'auto' ? 'Auto' : next === 'dark' ? 'Dark' : 'Light'}`;
  });
}

// --- Mobile nav ---
function closeSidebar() {
  sidebar.classList.remove('open');
  sidebarOverlay.style.display = 'none';
  document.body.style.overflow = '';
}

function openSidebar() {
  sidebar.classList.add('open');
  sidebarOverlay.style.display = 'block';
  document.body.style.overflow = 'hidden';
}

if (hamburgerBtn) {
  hamburgerBtn.addEventListener('click', () => {
    if (sidebar.classList.contains('open')) closeSidebar();
    else openSidebar();
  });
}

if (sidebarOverlay) {
  sidebarOverlay.addEventListener('click', closeSidebar);
}

// Close sidebar on nav link click (mobile)
sidebar.querySelectorAll('.nav-link').forEach((link) => {
  link.addEventListener('click', () => {
    if (window.innerWidth <= 768) closeSidebar();
  });
});

// --- Router ---
function route() {
  const hash = location.hash.slice(1) || 'deals';
  const [view, ...rest] = hash.split('/');
  const param = decodeURIComponent(rest.join('/') || '');

  document.querySelectorAll('.nav-link').forEach((link) => {
    link.classList.toggle('active', link.dataset.view === view);
  });

  switch (view) {
    case 'deals':
      renderDeals(main);
      break;
    case 'browse':
      renderBrowse(main);
      break;
    case 'favorites':
      renderFavorites(main);
      break;
    case 'stats':
      renderStats(main);
      break;
    case 'product':
      if (param) renderProduct(main, param);
      else location.hash = 'browse';
      break;
    default:
      location.hash = 'deals';
  }
}

window.addEventListener('hashchange', route);
route();
