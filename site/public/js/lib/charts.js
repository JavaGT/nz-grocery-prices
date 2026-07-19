import { esc, $c, fmtDate, imgHtml, initial } from './lib/utils.js';
import { isFavorite } from './lib/favorites.js';

const CHART_PALETTE = [
  '#2d8a4e', '#457b9d', '#e9c46a', '#e76f51', '#6d597a',
  '#2a9d8f', '#f4a261', '#264653', '#bc6c25', '#9b5de5',
];

const retailerColor = {
  paknsave: '#2d8a4e',
  newworld: '#c1121f',
  woolworths: '#007a33',
  freshchoice: '#e9c46a',
  warehouse: '#e63946',
};

function seriesKeyForObservation(o) {
  const store = o.store || {};
  return store.id || `${store.retailer || 'unknown'}:${store.name || 'store'}`;
}

function seriesLabelForObservation(o) {
  const store = o.store || {};
  const name = store.name || store.id || 'Store';
  return name
    .replace(/^PAK['\u2019]nSAVE\s+/i, "P'nS ")
    .replace(/^Woolworths\s+/i, 'WW ')
    .replace(/^New World\s+/i, 'NW ');
}

export function renderPriceChart(container, observations) {
  if (!observations || !observations.length) {
    container.innerHTML = '<p class="muted">Not enough data for a chart.</p>';
    return;
  }

  const byStore = new Map();
  for (const o of observations) {
    const key = seriesKeyForObservation(o);
    if (!byStore.has(key)) {
      byStore.set(key, {
        key,
        label: seriesLabelForObservation(o),
        retailer: o.store?.retailer || 'unknown',
        points: [],
      });
    }
    const r = (o.price?.regularCents ?? o.price?.currentCents) / 100;
    if (!Number.isFinite(r)) continue;
    byStore.get(key).points.push({
      t: new Date(o.observedAt || o.lastSeenAt).getTime(),
      r,
      p: o.price?.promoCents != null ? o.price.promoCents / 100 : null,
      mem: o.price?.memberCents != null ? o.price.memberCents / 100 : null,
    });
  }

  const series = [...byStore.values()]
    .map((s) => ({
      ...s,
      points: s.points
        .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.r))
        .sort((a, b) => a.t - b.t),
    }))
    .filter((s) => s.points.length > 0)
    .sort((a, b) => a.label.localeCompare(b.label, 'en-NZ'));

  const allPoints = series.flatMap((s) => s.points);
  if (!allPoints.length) {
    container.innerHTML = '<p class="muted">Not enough data for a chart.</p>';
    return;
  }

  const chartW = Math.min(container.clientWidth - 8 || 640, 800);
  const chartH = 280;
  const m = { top: 16, right: 12, bottom: 32, left: 56 };
  const iw = chartW - m.left - m.right;
  const ih = chartH - m.top - m.bottom;

  const allY = allPoints.flatMap((p) => [p.r, p.p, p.mem].filter((v) => v != null));
  let tMin = Math.min(...allPoints.map((p) => p.t));
  let tMax = Math.max(...allPoints.map((p) => p.t));
  if (tMax === tMin) {
    tMin -= 3_600_000;
    tMax += 3_600_000;
  }
  const yMin = Math.min(...allY);
  const yMax = Math.max(...allY);
  const yPad = (yMax - yMin) * 0.15 || 0.5;
  const yL = yMin - yPad;
  const yH = yMax + yPad;
  const x = (t) => m.left + ((t - tMin) / (tMax - tMin || 1)) * iw;
  const y = (v) => m.top + ih - ((v - yL) / (yH - yL || 1)) * ih;
  const fmtPrice = Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' });
  const fmtD = new Intl.DateTimeFormat('en-NZ', { month: 'short', day: 'numeric' });

  const multiRetailer = new Set(series.map((s) => s.retailer)).size > 1;
  const colorFor = (s, index) => {
    if (multiRetailer && retailerColor[s.retailer]) return retailerColor[s.retailer];
    return CHART_PALETTE[index % CHART_PALETTE.length];
  };

  let svg = `<svg width="${chartW}" height="${chartH}" viewBox="0 0 ${chartW} ${chartH}" style="max-width:100%" role="img" aria-label="Price history by store">`;

  // Grid lines
  for (let i = 0; i <= 5; i++) {
    const v = yL + (i / 5) * (yH - yL);
    const yy = y(v);
    svg += `<line x1="${m.left}" y1="${yy}" x2="${m.left + iw}" y2="${yy}" stroke="var(--border)" stroke-dasharray="3,3"/>`;
    svg += `<text x="${m.left - 6}" y="${yy + 3.5}" text-anchor="end" font-size="11" fill="var(--text-muted)">${esc(fmtPrice.format(v))}</text>`;
  }

  // Time ticks
  const timeTicks = [...new Set(allPoints.map((p) => p.t))].sort((a, b) => a - b);
  const nX = Math.min(Math.max(timeTicks.length - 1, 1), 6);
  for (let i = 0; i <= nX; i++) {
    const idx = Math.round((i / nX) * (timeTicks.length - 1));
    const tt = timeTicks[idx];
    svg += `<text x="${x(tt)}" y="${m.top + ih + 18}" text-anchor="middle" font-size="10" fill="var(--text-muted)">${esc(fmtD.format(new Date(tt)))}</text>`;
  }

  // Lines and dots
  series.forEach((s, index) => {
    const color = colorFor(s, index);
    const pts = s.points.map((p) => `${x(p.t)},${y(p.r)}`).join(' ');
    if (s.points.length >= 2) {
      svg += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" opacity="0.9"/>`;
    }
    s.points.forEach((p) => {
      svg += `<circle cx="${x(p.t)}" cy="${y(p.r)}" r="3.5" fill="${color}" stroke="var(--surface)" stroke-width="1.2"><title>${esc(s.label)} · ${fmtPrice.format(p.r)}</title></circle>`;
      if (p.p != null && Math.abs(p.p - p.r) > 0.01) {
        svg += `<circle cx="${x(p.t)}" cy="${y(p.p)}" r="3" fill="#e63946" stroke="var(--surface)" stroke-width="1"><title>${esc(s.label)} promo · ${fmtPrice.format(p.p)}</title></circle>`;
      }
      if (p.mem != null) {
        svg += `<circle cx="${x(p.t)}" cy="${y(p.mem)}" r="2.5" fill="#457b9d" stroke="var(--surface)" stroke-width="1"><title>${esc(s.label)} member · ${fmtPrice.format(p.mem)}</title></circle>`;
      }
    });
  });

  svg += '</svg>';

  // Legend
  let legend = '';
  if (multiRetailer) {
    const seen = new Set();
    legend = series
      .map((s) => {
        if (seen.has(s.retailer)) return '';
        seen.add(s.retailer);
        return `<span class="legend-item"><span class="legend-dot" style="background:${retailerColor[s.retailer] || '#666'}"></span>${esc(s.retailer)}</span>`;
      })
      .join('');
  } else if (series.length <= 12) {
    legend = series.map((s, i) =>
      `<span class="legend-item"><span class="legend-dot" style="background:${colorFor(s, i)}"></span>${esc(s.label)}</span>`,
    ).join('');
  } else {
    legend = `<span class="legend-item muted">${series.length} stores · each dot is one store's price</span>`;
  }
  legend += `
    <span class="legend-item"><span class="legend-dot" style="background:#e63946"></span> Promo</span>
    <span class="legend-item"><span class="legend-dot" style="background:#457b9d"></span> Member</span>`;

  container.innerHTML = `<div class="chart-legend">${legend}</div>${svg}`;
}
