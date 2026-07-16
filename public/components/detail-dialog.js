import { el, esc, clear } from '../utils/dom.js';
import { formatCents, formatDate, formatShortDate, formatDropPercent, retailerLabel, retailerColor as rc } from '../utils/format.js';

export function openDetailDialog(offer, api) {
  const existing = document.getElementById('detail-dialog');
  if (existing) existing.remove();

  const dialog = el('dialog', { id: 'detail-dialog', className: 'detail-dialog' });
  const overlay = el('div', { className: 'dialog-overlay', onClick: () => dialog.close() });
  dialog.appendChild(overlay);

  const panel = el('div', { className: 'dialog-panel', role: 'document' });

  const closeBtn = el('button', {
    className: 'dialog-close', 'aria-label': 'Close detail',
    onClick: () => dialog.close()
  }, '\u2715');
  panel.appendChild(closeBtn);

  panel.appendChild(el('h2', { className: 'dialog-title' }, esc(offer.productName || 'Product')));

  const meta = el('div', { className: 'dialog-meta' });
  const brandLabel = el('span', { className: 'pc-brandmark', style: `--brand-color:${rc(offer.retailer)}` }, retailerLabel(offer.retailer));
  meta.appendChild(brandLabel);
  meta.appendChild(el('span', { className: 'dialog-store' }, esc(offer.storeName || '')));
  if (offer.priceKind) {
    const kindLabels = { regular: 'Shelf price', promo: 'Special', member: 'Member price' };
    meta.appendChild(el('span', { className: 'pc-kind' }, kindLabels[offer.priceKind] || offer.priceKind));
  }
  panel.appendChild(meta);

  const priceRow = el('div', { className: 'dialog-price-row' });
  priceRow.appendChild(el('span', { className: 'dialog-price' }, formatCents(offer.currentCents)));
  if (offer.regularCents && offer.regularCents !== offer.currentCents) {
    priceRow.appendChild(el('span', { className: 'dialog-was' }, formatCents(offer.regularCents)));
    const drop = formatDropPercent(offer.currentCents, offer.regularCents);
    if (drop) priceRow.appendChild(el('span', { className: 'dialog-save' }, `Save ${drop}%`));
  }
  panel.appendChild(priceRow);

  if (offer.signalLabel) {
    panel.appendChild(el('div', { className: 'dialog-signal' }, esc(offer.signalLabel)));
  }

  if (offer.promotionData) {
    const prom = typeof offer.promotionData === 'string' ? JSON.parse(offer.promotionData) : offer.promotionData;
    panel.appendChild(el('div', { className: 'dialog-promo' },
      esc(prom.type || 'Promotion') + (prom.savePercent ? ` \u2014 save ${prom.savePercent}%` : '')
    ));
  }

  const source = el('div', { className: 'dialog-source' });
  source.appendChild(el('strong', {}, 'Price source'));
  source.appendChild(el('span', {}, esc(offer.sourceLabel || 'Live collection')));
  if (offer.observedAt) {
    source.appendChild(el('span', {}, `Observed ${formatRelativeTime(offer.observedAt)}`));
  }
  panel.appendChild(source);

  if (offer.productId) {
    const historyBtn = el('button', {
      className: 'btn btn-outline', style: 'margin-top:16px;width:100%',
      onClick: () => { dialog.close(); loadHistory(offer.productId, api); }
    }, 'View price history');
    panel.appendChild(historyBtn);
  }

  dialog.appendChild(panel);
  document.body.appendChild(dialog);

  dialog.showModal();
  dialog.addEventListener('close', () => dialog.remove());
  dialog.addEventListener('click', e => { if (e.target === dialog) dialog.close(); });

  document.addEventListener('keydown', function handler(e) {
    if (e.key === 'Escape' && document.getElementById('detail-dialog')) {
      dialog.close();
      document.removeEventListener('keydown', handler);
    }
  });
}

let historyDialog = null;

async function loadHistory(productId, api) {
  if (historyDialog) historyDialog.close();

  const outer = el('dialog', { id: 'history-dialog', className: 'detail-dialog' });
  const overlay = el('div', { className: 'dialog-overlay', onClick: () => outer.close() });
  outer.appendChild(overlay);

  const panel = el('div', { className: 'dialog-panel dialog-panel--wide' });

  const closeBtn = el('button', { className: 'dialog-close', 'aria-label': 'Close history', onClick: () => outer.close() }, '\u2715');
  panel.appendChild(closeBtn);

  const loading = el('div', { className: 'skeleton-block sk-w80', style: 'height:24px;margin-bottom:16px' });
  panel.appendChild(loading);
  outer.appendChild(panel);
  document.body.appendChild(outer);
  outer.showModal();
  historyDialog = outer;

  try {
    const data = await api.productHistory(productId);
    clear(panel);
    panel.appendChild(closeBtn);

    if (data.error || !data.points?.length) {
      panel.appendChild(el('h2', { className: 'dialog-title' }, 'Price History'));
      panel.appendChild(el('p', { className: 'empty-sub' }, 'Not enough price history available yet.'));
      return;
    }

    panel.appendChild(el('h2', { className: 'dialog-title' }, `Price History`));

    const chartContainer = el('div', { className: 'chart-container' });
    renderSparkline(chartContainer, data.points);
    panel.appendChild(chartContainer);

    const table = el('table', { className: 'history-table' });
    table.innerHTML = `<thead><tr><th>Date</th><th>Price</th></tr></thead>`;
    const tbody = el('tbody');
    for (const pt of data.points) {
      const tr = el('tr', {},
        el('td', {}, formatDate(pt.at)),
        el('td', { className: 'td-price' }, formatCents(pt.cents))
      );
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    panel.appendChild(table);
  } catch (e) {
    clear(panel);
    panel.appendChild(closeBtn);
    panel.appendChild(el('p', { className: 'error-state' }, 'Could not load price history.'));
  }
}

function renderSparkline(container, points) {
  if (!points?.length) return;
  const sorted = [...points].sort((a, b) => new Date(a.at) - new Date(b.at));
  const w = Math.min(container.clientWidth || 600, 600);
  const h = 200;
  const pad = { top: 20, right: 16, bottom: 28, left: 56 };
  const iw = w - pad.left - pad.right;
  const ih = h - pad.top - pad.bottom;

  const vals = sorted.map(p => p.cents);
  const times = sorted.map(p => new Date(p.at).getTime());
  const tMin = times[0], tMax = times[times.length - 1];
  const yMin = Math.min(...vals), yMax = Math.max(...vals);
  const padY = (yMax - yMin) * 0.1 || 50;
  const yLo = yMin - padY, yHi = yMax + padY;

  const sx = t => pad.left + ((t - tMin) / (tMax - tMin)) * iw;
  const sy = v => pad.top + ih - ((v - yLo) / (yHi - yLo)) * ih;

  let svg = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="max-width:100%;display:block">`;

  const nY = 4;
  for (let i = 0; i <= nY; i++) {
    const v = yLo + (i / nY) * (yHi - yLo);
    const yy = sy(v);
    svg += `<line x1="${pad.left}" y1="${yy}" x2="${pad.left+iw}" y2="${yy}" stroke="#e3e5df" stroke-dasharray="3,3"/>`;
    svg += `<text x="${pad.left-6}" y="${yy+4}" text-anchor="end" font-size="11" fill="#637168">${formatCents(Math.round(v))}</text>`;
  }

  const nX = Math.min(sorted.length - 1, 5);
  for (let i = 0; i <= nX; i++) {
    const idx = Math.round((i / nX) * (sorted.length - 1));
    const xx = sx(times[idx]);
    svg += `<text x="${xx}" y="${pad.top+ih+18}" text-anchor="middle" font-size="10" fill="#637168">${formatShortDate(sorted[idx].at)}</text>`;
  }

  const pts = sorted.map(p => `${sx(new Date(p.at).getTime())},${sy(p.cents)}`).join(' ');
  svg += `<polygon points="${pad.left},${pad.top+ih} ${pts} ${pad.left+iw},${pad.top+ih}" fill="rgba(7,95,59,0.08)"/>`;
  svg += `<polyline points="${pts}" fill="none" stroke="#075f3b" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;

  const step = Math.max(1, Math.floor(sorted.length / 15));
  sorted.forEach((p, i) => {
    if (i % step !== 0 && i !== sorted.length - 1) return;
    const cx = sx(new Date(p.at).getTime());
    const cy = sy(p.cents);
    svg += `<circle cx="${cx}" cy="${cy}" r="3" fill="#075f3b" stroke="#fff" stroke-width="1.5"/>`;
  });

  svg += '</svg>';
  container.innerHTML = svg;
}

function formatRelativeTime(observedAt) {
  const diff = Date.now() - (typeof observedAt === 'number' ? observedAt : new Date(observedAt).getTime());
  const h = Math.floor(diff / 3600000);
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export function closeHistoryDialog() {
  if (historyDialog) { historyDialog.close(); historyDialog = null; }
}
