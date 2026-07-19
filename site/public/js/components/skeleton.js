export function skeletonCards(count = 8) {
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `<div class="skeleton-card">
      <div class="skeleton skeleton-img"></div>
      <div class="skeleton-body">
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton skeleton-line"></div>
      </div>
    </div>`;
  }
  return html;
}

export function skeletonTable(rows = 5, cols = 4) {
  let html = '<div class="card" style="padding:0;overflow:hidden">';
  for (let i = 0; i < rows; i++) {
    html += `<div style="display:grid;grid-template-columns:repeat(${cols},1fr);gap:12px;padding:12px;border-bottom:1px solid var(--border)">
      ${Array.from({ length: cols }, () => '<div class="skeleton" style="height:14px;border-radius:4px"></div>').join('')}
    </div>`;
  }
  html += '</div>';
  return html;
}
