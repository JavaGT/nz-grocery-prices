import { api } from "../api.js";

const BADGE_CLASS = {
  paknsave: "badge-paknsave",
  newworld: "badge-newworld",
  woolworths: "badge-woolworths",
  freshchoice: "badge-freshchoice",
  warehouse: "badge-warehouse",
};

function badge(retailer) {
  return BADGE_CLASS[retailer] || "badge-default";
}

function $c(v) { return v != null ? `$${(v / 100).toFixed(2)}` : ""; }

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

function saleCard(s, isOngoing) {
  return `<div class="card product-card" data-pid="${esc(s.productId)}">
    <div style="display:flex;justify-content:space-between;align-items:start;margin-bottom:8px">
      <div>
        <div style="font-weight:600;margin-bottom:2px">${esc(s.productName)}</div>
        ${s.brand ? `<div style="font-size:13px;color:#888">${esc(s.brand)}</div>` : ""}
      </div>
      <span class="badge ${badge(s.retailer)}">${s.retailer}</span>
    </div>
    <div style="display:flex;align-items:baseline;gap:8px;flex-wrap:wrap">
      <span class="price-current">${$c(s.currentCents)}</span>
      ${s.regularCents ? `<span class="price-regular">${$c(s.regularCents)}</span>` : ""}
      ${s.savePercent != null ? `<span class="price-save">-${s.savePercent.toFixed(1)}%</span>` : ""}
      ${s.dropPercent != null ? `<span class="price-drops">↓${s.dropPercent.toFixed(1)}%</span>` : ""}
      ${s.isAllTimeLow ? `<span class="atl-badge">🏆 All-time low</span>` : ""}
    </div>
    ${isOngoing ? `<div style="font-size:12px;color:#2d8a4e;margin-top:4px">On special${s.promotion?.savePercent ? ` — save ${s.promotion.savePercent}%` : ""}</div>` : ""}
    ${s.baselineAverageCents != null ? `<div style="font-size:12px;color:#999;margin-top:4px">Avg ${$c(s.baselineAverageCents)} (${s.baselineSampleCount} samples)</div>` : ""}
    <div style="font-size:12px;color:#999;margin-top:4px">${esc(s.storeName)}</div>
  </div>`;
}

export async function renderDeals(container) {
  container.innerHTML = `<div class="loading">Loading deals…</div>`;
  try {
    const storeList = await api.stores();
    const [feed] = await Promise.all([api.feed({ minDropPercent: 5, limit: 100 })]);

    let filter = "";

    function render() {
      const ongoing = !filter ? (feed.ongoingSales || []) : (feed.ongoingSales || []).filter(s => s.storeId === filter);
      const sales = !filter ? (feed.sales || []) : (feed.sales || []).filter(s => s.storeId === filter);

      let html = `
        <div class="page-header">
          <h2>Deals</h2>
          <p>${sales.length} price drops · ${ongoing.length} current promotions</p>
        </div>
        <div class="filter-bar">
          <select id="deals-filter">
            <option value="">All stores</option>
            ${storeList.map(s => `<option value="${esc(s.id)}"${s.id === filter ? " selected" : ""}>${esc(s.name)}</option>`).join("")}
          </select>
        </div>
      `;

      if (sales.length) {
        html += `<h3 style="margin-bottom:16px;font-size:18px">Price drops</h3>`;
        html += `<div class="deals-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px">`;
        html += sales.map(s => saleCard(s, false)).join("");
        html += `</div>`;
      }

      if (ongoing.length) {
        html += `<h3 style="margin:24px 0 16px;font-size:18px">Current promotions</h3>`;
        html += `<div class="deals-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:12px">`;
        html += ongoing.map(s => saleCard(s, true)).join("");
        html += `</div>`;
      }

      if (!sales.length && !ongoing.length) {
        html += `<div class="empty-state"><p>No deals to show.</p></div>`;
      }

      container.innerHTML = html;
      document.getElementById("deals-filter")?.addEventListener("change", e => { filter = e.target.value; render(); });
      container.querySelectorAll(".product-card").forEach(el => {
        el.addEventListener("click", () => location.hash = "product/" + encodeURIComponent(el.dataset.pid));
      });
    }

    render();
  } catch (e) {
    container.innerHTML = `<div class="error">Failed to load deals: ${e.message}</div>`;
  }
}