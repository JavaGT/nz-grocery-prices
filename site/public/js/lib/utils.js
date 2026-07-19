export function esc(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

export function $c(v) {
  return Number.isFinite(v) ? `$${(v / 100).toFixed(2)}` : '';
}

export function fmtDate(iso, withYear = false) {
  if (!iso) return '—';
  const opts = withYear
    ? { month: 'short', day: 'numeric', year: 'numeric' }
    : { month: 'short', day: 'numeric' };
  return new Date(iso).toLocaleDateString('en-NZ', opts);
}

export function badgeClass(retailer) {
  return `badge badge-${(retailer || 'default').toLowerCase().replace(/\s+/g, '')}`;
}

export function initial(name) {
  return (name || '?').trim().charAt(0).toUpperCase() || '?';
}

export function imgHtml(url, name, cls = '') {
  if (url) {
    return `<img src="${esc(url)}" alt="${esc(name || '')}" loading="lazy" class="${cls}" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'ph',textContent:'${esc(initial(name))}'}))">`;
  }
  return `<div class="ph">${esc(initial(name))}</div>`;
}

export function viewToggleHtml(mode) {
  return `<div class="view-toggle" role="group" aria-label="View mode">
    <button type="button" class="btn btn-sm ${mode === 'grid' ? 'active' : ''}" data-viewmode="grid" aria-pressed="${mode === 'grid'}">Grid</button>
    <button type="button" class="btn btn-sm ${mode === 'list' ? 'active' : ''}" data-viewmode="list" aria-pressed="${mode === 'list'}">List</button>
  </div>`;
}

export function bindViewToggle(container, onChange) {
  container.querySelectorAll('[data-viewmode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.viewmode;
      setViewMode(mode);
      onChange(mode);
    });
  });
}

export function bindProductClicks(container) {
  const go = (el) => {
    const pid = el.closest('[data-pid]')?.dataset.pid;
    if (pid) location.hash = `product/${encodeURIComponent(pid)}`;
  };
  container.querySelectorAll('[data-pid]').forEach((el) => {
    el.addEventListener('click', () => go(el));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(el); }
    });
  });
}

export function getViewMode() {
  return localStorage.getItem('nz-grocery-view-mode') === 'list' ? 'list' : 'grid';
}

export function setViewMode(mode) {
  localStorage.setItem('nz-grocery-view-mode', mode === 'list' ? 'list' : 'grid');
}
