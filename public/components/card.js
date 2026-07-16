import { el, esc } from '../utils/dom.js';
import { formatCents, formatDropPercent, formatRelativeTime, freshnessLevel, retailerColor as rc, retailerLabel } from '../utils/format.js';

export function createProductCard(offer, opts = {}) {
  const { onClick, onWatch } = opts;
  const dropPct = formatDropPercent(offer.currentCents, offer.regularCents);
  const freshness = freshnessLevel(offer.observedAt);

  const freshnessColors = { fresh: '#075f3b', stale: '#d68a00', old: '#c0392b', none: '#999' };
  const freshnessLabels = { fresh: 'Fresh', stale: '7-14d old', old: '>14d old', none: 'Unknown' };

  const card = el('article', { className: 'product-card', role: 'button', tabindex: '0' });

  const imgWrap = el('div', { className: 'pc-image' });
  const img = el('img', {
    alt: offer.productName ? esc(offer.productName) : '',
    loading: 'lazy',
  });
  img.addEventListener('error', () => { img.style.display = 'none'; });
  if (offer.imageUrl) img.src = offer.imageUrl;
  else img.style.display = 'none';
  imgWrap.appendChild(img);

  if (!offer.imageUrl) {
    const placeholder = el('div', { className: 'pc-placeholder' },
      el('span', {}, (offer.productName || '?')[0].toUpperCase())
    );
    placeholder.style.setProperty('--brand-color', rc(offer.retailer));
    imgWrap.appendChild(placeholder);
  }

  if (offer.signalLabel) {
    imgWrap.appendChild(el('span', { className: 'pc-signal' }, esc(offer.signalLabel)));
  }

  const brandEl = el('span', { className: 'pc-brandmark' });
  brandEl.style.setProperty('--brand-color', rc(offer.retailer));
  brandEl.textContent = retailerLabel(offer.retailer);
  imgWrap.appendChild(brandEl);

  card.appendChild(imgWrap);

  const body = el('div', { className: 'pc-body' });

  const storeLine = el('div', { className: 'pc-storeline' });
  const freshnessDot = el('span', {
    className: 'pc-freshness-dot',
    style: `background:${freshnessColors[freshness]}`,
    title: freshnessLabels[freshness],
  }, '\u00a0');
  storeLine.appendChild(freshnessDot);
  storeLine.appendChild(document.createTextNode(` ${esc(offer.storeName || '')}`));
  body.appendChild(storeLine);

  const title = el('h3', { className: 'pc-title' }, esc(offer.productName || ''));
  body.appendChild(title);

  const priceBox = el('div', { className: 'pc-pricebox' });
  priceBox.appendChild(el('span', { className: 'pc-now' }, formatCents(offer.currentCents)));
  if (offer.regularCents != null && offer.regularCents !== offer.currentCents) {
    priceBox.appendChild(el('span', { className: 'pc-was' }, formatCents(offer.regularCents)));
  }
  if (dropPct != null && dropPct > 0) {
    priceBox.appendChild(el('span', { className: 'pc-save' }, `\u2212${dropPct}%`));
  }
  body.appendChild(priceBox);

  if (offer.priceKind) {
    const kindLabels = { regular: 'Shelf price', promo: 'Special', member: 'Member price' };
    body.appendChild(el('span', { className: 'pc-kind' }, kindLabels[offer.priceKind] || offer.priceKind));
  }

  card.appendChild(body);

  card.addEventListener('click', () => onClick?.(offer));
  card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(offer); } });

  return card;
}

export function createSkeletonCard() {
  const card = el('div', { className: 'product-card skeleton', 'aria-hidden': 'true' });
  const imgWrap = el('div', { className: 'pc-image sk-img' });
  card.appendChild(imgWrap);
  const body = el('div', { className: 'pc-body' });
  body.appendChild(el('div', { className: 'sk-line sk-w40' }));
  body.appendChild(el('div', { className: 'sk-line sk-w80', style: 'height:18px;margin:8px 0 12px' }));
  body.appendChild(el('div', { className: 'sk-line sk-w30' }));
  card.appendChild(body);
  return card;
}

export function createEmptyState(message, subMessage) {
  const wrap = el('div', { className: 'empty-state' });
  wrap.appendChild(el('p', {}, esc(message)));
  if (subMessage) wrap.appendChild(el('p', { className: 'empty-sub' }, esc(subMessage)));
  return wrap;
}

export function createErrorState(message, onRetry) {
  const wrap = el('div', { className: 'error-state' });
  wrap.appendChild(el('p', {}, esc(message)));
  if (onRetry) {
    wrap.appendChild(el('button', { className: 'btn btn-outline', onClick: onRetry }, 'Try again'));
  }
  return wrap;
}

export function createFreshnessBanner(freshness) {
  if (!freshness) return null;
  const { latestCollection, totalStores, storesWithData } = freshness;
  const isStale = !latestCollection || (Date.now() - new Date(latestCollection).getTime()) > 86400000;
  if (!latestCollection && !totalStores) {
    return el('div', { className: 'freshness-banner pending' },
      'Awaiting first price collection \u2014 this can take a few minutes'
    );
  }
  const banner = el('div', { className: `freshness-banner ${isStale ? 'stale' : 'ok'}` });
  if (latestCollection) {
    banner.appendChild(document.createTextNode(`Prices collected ${formatRelativeTime(new Date(latestCollection).getTime())}`));
  }
  if (totalStores != null && storesWithData != null) {
    const pct = totalStores > 0 ? Math.round(storesWithData / totalStores * 100) : 0;
    banner.appendChild(document.createTextNode(` \u00b7 ${storesWithData}/${totalStores} stores with data`));
  }
  return banner;
}
