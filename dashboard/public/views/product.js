import { api } from "../api.js";
import { renderPriceChart } from "../components/price-chart.js";
import { isFavorite, addFavorite, removeFavorite } from "../favorites-store.js";

function $c(v) { return v != null ? `$${(v / 100).toFixed(2)}` : ""; }
function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function d(iso) { return new Date(iso).toLocaleDateString("en-NZ", { month: "short", day: "numeric", year: "numeric" }); }

export async function renderProduct(container, productId) {
  container.innerHTML = `<div class="loading">Loading product…</div>`;

  try {
    const { history, revisions } = await api.productHistory(productId);
    if (!history.length) {
      container.innerHTML = `<div class="empty-state"><p>Product not found.</p></div>`;
      return;
    }

    const latest = history[history.length - 1];
    const p = latest.product;
    const fav = isFavorite(productId);

    let html = `
      <button class="back-link" id="back-btn">← Back</button>
      <div class="page-header">
        <h2>${esc(p.name)}</h2>
        ${p.brand ? `<p>${esc(p.brand)}</p>` : ""}
      </div>
      <div style="display:flex;gap:12px;margin-bottom:20px">
        <button class="btn ${fav ? "btn-danger" : "btn-outline"} btn-sm" id="fav-btn">${fav ? "♥ Saved" : "♡ Save"}</button>
        <span class="badge badge-${latest.store.retailer}">${latest.store.retailer}</span>
      </div>
      <div class="card">
        <dl class="info-grid">
          <dt>Product ID</dt><dd style="font-family:monospace;font-size:12px">${esc(productId)}</dd>
          ${p.gtin ? `<dt>GTIN</dt><dd>${esc(p.gtin)}</dd>` : ""}
          ${p.categories?.length ? `<dt>Categories</dt><dd>${p.categories.map(c => esc(c)).join(" · ")}</dd>` : ""}
          ${latest.store.name ? `<dt>Store</dt><dd>${esc(latest.store.name)}${latest.store.address ? ` — ${esc(latest.store.address)}` : ""}${latest.store.region ? `, ${esc(latest.store.region)}` : ""}</dd>` : ""}
          <dt>Revisions</dt><dd>${revisions.length} product metadata changes</dd>
          <dt>Observations</dt><dd>${history.length} price records</dd>
        </dl>
      </div>
      <h3 style="margin:24px 0 12px;font-size:18px">Price history</h3>
      <div class="card chart-container" id="chart-container"></div>
      <div class="card">
        <table>
          <thead><tr><th>Date</th><th>Store</th><th>Regular</th><th>Promo</th><th>Member</th></tr></thead>
          <tbody>
            ${history.toReversed().map(o => `
              <tr>
                <td>${d(o.observedAt)}</td>
                <td>${esc(o.store.name)}</td>
                <td>${$c(o.price.regularCents)}</td>
                <td>${o.price.promoCents != null ? $c(o.price.promoCents) : "—"}</td>
                <td>${o.price.memberCents != null ? $c(o.price.memberCents) : "—"}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;

    container.innerHTML = html;
    document.getElementById("back-btn").addEventListener("click", () => history.back());
    document.getElementById("fav-btn").addEventListener("click", () => {
      if (isFavorite(productId)) {
        removeFavorite(productId);
        document.getElementById("fav-btn").textContent = "♡ Save";
        document.getElementById("fav-btn").className = "btn btn-outline btn-sm";
      } else {
        addFavorite(productId);
        document.getElementById("fav-btn").textContent = "♥ Saved";
        document.getElementById("fav-btn").className = "btn btn-danger btn-sm";
      }
    });

    renderPriceChart(document.getElementById("chart-container"), history, p.name);
  } catch (e) {
    container.innerHTML = `<div class="error">Failed to load product: ${e.message}</div>`;
  }
}