const THEME_KEY = 'nz-grocery-theme';

export function getTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  return 'auto';
}

export function applyTheme(theme) {
  if (theme === 'auto') {
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.setAttribute('data-theme',
      window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

export function toggleTheme() {
  const current = getTheme();
  const next = current === 'dark' ? 'light' : current === 'light' ? 'auto' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
  return next;
}

export function getThemeIcon(theme) {
  if (theme === 'dark') return '🌙';
  if (theme === 'light') return '☀️';
  return '💻';
}

export function initTheme() {
  // Listen for system preference changes when in auto mode
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getTheme() === 'auto') applyTheme('auto');
  });

  applyTheme(getTheme());
}
