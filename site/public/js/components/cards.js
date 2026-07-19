import { esc, $c, fmtDate, imgHtml, badgeClass } from '../lib/utils.js';
import { isFavorite } from '../lib/favorites.js';

export function dealCardHtml(s) {
  const save = s.savePercent != null ? s.savePercent : s.dropPercent;
  const was = s.regularCents ?? s.baselineAverageCents;
  return `<article class="card product-card" data-pid="${esc(s.productId)}" tabindex="0" role="link">
    <div class="card-img">
      ${imgHtml(s.imageUrl, s.productName)}
      ${isFavorite(s.productId) ? '<span class="fav-mark">♥</span>' : ''}
    </div>
    <div class="card-body">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:start">
        <h3>${esc(s.productName)}</h3>
        <span class="${badgeClass(s.retailer)}">${esc(s.retailer)}</span>
      </div>
      <div class="card-meta">${s.brand ? esc(s.brand) + ' · ' : ''}${esc(s.storeName || '')}</div>
      <div class="card-prices">
        <span class="price-current">${$c(s.currentCents)}</span>
        ${was != null ? `<span class="price-regular">${$c(was)}</span>` : ''}
        ${save != null ? `<span class="${s.dropPercent != null ? 'price-drops' : 'price-save'}">${s.dropPercent != null ? '↓' : '−'}${Number(save).toFixed(0)}%</span>` : ''}
      </div>
      <div class="card-signals">
        ${s.isAllTimeLow ? '<span class="atl-badge">🏆 All-time low</span>' : ''}
        ${s.signalLabel ? `<span class="muted">${esc(s.signalLabel)}</span>` : ''}
      </div>
    </div>
  </article>`;
}

export function dealListHtml(s) {
  const save = s.savePercent != null ? s.savePercent : s.dropPercent;
  const was = s.regularCents ?? s.baselineAverageCents;
  return `<div class="list-row" data-pid="${esc(s.productId)}" tabindex="0" role="link">
    <div class="list-thumb">${imgHtml(s.imageUrl, s.productName)}</div>
    <div class="list-main">
      <h3>${esc(s.productName)}${isFavorite(s.productId) ? ' <span style="color:var(--fav-color)">♥</span>' : ''}</h3>
      <div class="meta">${s.brand ? esc(s.brand) + ' · ' : ''}${esc(s.storeName || '')} · <span class="${badgeClass(s.retailer)}">${esc(s.retailer)}</span></div>
    </div>
    <div class="list-side">
      <span class="price-current">${$c(s.currentCents)}</span>
      <div>
        ${was != null ? `<span class="price-regular">${$c(was)}</span> ` : ''}
        ${save != null ? `<span class="${s.dropPercent != null ? 'price-drops' : 'price-save'}">${s.dropPercent != null ? '↓' : '−'}${Number(save).toFixed(0)}%</span>` : ''}
      </div>
    </div>
  </div>`;
}

export function productCardHtml(p) {
  return `<article class="card product-card" data-pid="${esc(p.id)}" tabindex="0" role="link">
    <div class="card-img">
      ${imgHtml(p.imageUrl, p.name)}
      ${isFavorite(p.id) ? '<span class="fav-mark">♥</span>' : ''}
    </div>
    <div class="card-body">
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:start">
        <h3>${esc(p.name)}</h3>
        <span class="${badgeClass(p.retailer)}">${esc(p.retailer)}</span>
      </div>
      <div class="card-meta">${p.brand ? esc(p.brand) + ' · ' : ''}${esc(p.storeName || '')}</div>
      <div class="card-prices">
        ${p.currentCents != null ? `<span class="price-current">${$c(p.currentCents)}</span>` : '<span class="muted">No price</span>'}
        ${p.regularCents != null && p.regularCents !== p.currentCents ? `<span class="price-regular">${$c(p.regularCents)}</span>` : ''}
      </div>
      <div class="muted">${fmtDate(p.lastSeen)}</div>
    </div>
  </article>`;
}

export function productListHtml(p) {
  return `<div class="list-row" data-pid="${esc(p.id)}" tabindex="0" role="link">
    <div class="list-thumb">${imgHtml(p.imageUrl, p.name)}</div>
    <div class="list-main">
      <h3>${esc(p.name)}${isFavorite(p.id) ? ' <span style="color:var(--fav-color)">♥</span>' : ''}</h3>
      <div class="meta">${p.brand ? esc(p.brand) + ' · ' : ''}<span class="${badgeClass(p.retailer)}">${esc(p.retailer)}</span> · ${fmtDate(p.lastSeen)}</div>
    </div>
    <div class="list-side">
      ${p.currentCents != null ? `<span class="price-current">${$c(p.currentCents)}</span>` : '<span class="muted">—</span>'}
    </div>
  </div>`;
}
