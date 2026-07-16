export function renderPriceChart(container, observations, title) {
  if (!observations || observations.length < 2) {
    container.innerHTML = "<p style='color:#999;font-size:13px'>Not enough data for a chart.</p>";
    return;
  }

  const chartW = Math.min(container.clientWidth - 40, 800);
  const chartH = 260;
  const m = { top: 16, right: 12, bottom: 32, left: 56 };
  const iw = chartW - m.left - m.right;
  const ih = chartH - m.top - m.bottom;

  const points = observations.map(o => ({
    t: new Date(o.observedAt).getTime(),
    r: o.price.regularCents / 100,
    p: o.price.promoCents != null ? o.price.promoCents / 100 : null,
    m: o.price.memberCents != null ? o.price.memberCents / 100 : null,
  })).sort((a, b) => a.t - b.t);

  const all = points.flatMap(p => [p.r, p.p, p.m].filter(v => v != null));
  const tMin = points[0].t, tMax = points[points.length - 1].t;
  const yMin = Math.min(...all), yMax = Math.max(...all);
  const yPad = (yMax - yMin) * 0.15 || 0.5;
  const yL = yMin - yPad, yH = yMax + yPad;

  const x = t => m.left + ((t - tMin) / (tMax - tMin)) * iw;
  const y = v => m.top + ih - ((v - yL) / (yH - yL)) * ih;

  const fmtPrice = Intl.NumberFormat("en-NZ", { style: "currency", currency: "NZD" });
  const fmtDate = new Intl.DateTimeFormat("en-NZ", { month: "short", day: "numeric" });

  let svg = `<svg width="${chartW}" height="${chartH}" viewBox="0 0 ${chartW} ${chartH}" style="max-width:100%"><defs>
    <linearGradient id="r-line" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2d8a4e" stop-opacity=".1"/><stop offset="100%" stop-color="#2d8a4e" stop-opacity=".01"/></linearGradient>
  </defs>`;

  // Grid + Y labels
  const nY = 5;
  for (let i = 0; i <= nY; i++) {
    const v = yL + (i / nY) * (yH - yL);
    const yy = y(v);
    svg += `<line x1="${m.left}" y1="${yy}" x2="${m.left + iw}" y2="${yy}" stroke="#eee" stroke-dasharray="3,3"/>`;
    svg += `<text x="${m.left - 6}" y="${yy + 3.5}" text-anchor="end" font-size="11" fill="#888">${fmtPrice.format(v)}</text>`;
  }

  // X labels
  const nX = Math.min(points.length - 1, 6);
  for (let i = 0; i <= nX; i++) {
    const idx = Math.round((i / nX) * (points.length - 1));
    const xx = x(points[idx].t);
    svg += `<text x="${xx}" y="${m.top + ih + 18}" text-anchor="middle" font-size="10" fill="#888">${fmtDate.format(new Date(points[idx].t))}</text>`;
  }

  // Area fill under regular line
  const pts = points.map(p => `${x(p.t)},${y(p.r)}`).join(" ");
  svg += `<polygon points="${m.left},${m.top + ih} ${pts} ${m.left + iw},${m.top + ih}" fill="url(#r-line)"/>`;

  // Regular price line
  svg += `<polyline points="${pts}" fill="none" stroke="#2d8a4e" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;

  // Regular price dots (sparse)
  const dotStep = Math.max(1, Math.floor(points.length / 20));
  points.forEach((p, i) => {
    if (i % dotStep !== 0 && i !== points.length - 1) return;
    svg += `<circle cx="${x(p.t)}" cy="${y(p.r)}" r="3" fill="#2d8a4e" stroke="#fff" stroke-width="1.5"/>`;
  });

  // Promo dots
  points.forEach(p => {
    if (p.p != null && Math.abs(p.p - p.r) > 0.01) {
      svg += `<circle cx="${x(p.t)}" cy="${y(p.p)}" r="4" fill="#e63946" stroke="#fff" stroke-width="1.5"/>`;
    }
  });

  // Member dots
  points.forEach(p => {
    if (p.m != null && Math.abs(p.m - (p.p ?? p.r)) > 0.01) {
      svg += `<circle cx="${x(p.t)}" cy="${y(p.m)}" r="3.5" fill="#457b9d" stroke="#fff" stroke-width="1.5"/>`;
    }
  });

  svg += "</svg>";

  container.innerHTML = `
    <div class="chart-legend">
      <span class="legend-item"><span class="legend-dot" style="background:#2d8a4e"></span> Regular</span>
      <span class="legend-item"><span class="legend-dot" style="background:#e63946"></span> Promo</span>
      <span class="legend-item"><span class="legend-dot" style="background:#457b9d"></span> Member</span>
    </div>
    ${svg}
  `;
}