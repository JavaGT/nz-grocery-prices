import { api } from "../api.js";
import { getFavorites, removeFavorite } from "../favorites-store.js";

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

export async function renderFavorites(container) {
  container.innerHTML = `<div class="loading">Loading favorites…</div>`;

  try {
    const favs = getFavorites();
    if (!favs.length) {
      container.innerHTML = `
        <div class="page-header"><h2>Favorites</h2></div>
        <div class="empty-state"><p>No favorites saved yet.</p><p style="font-size:13px;margin-top:4px">Browse products and click ♡ to save them here.</p></div>
      `;
      return;
    }

    const { products } = await api.products();
    const favProducts = favs.map(id => products.find(p => p.id === id)).filter(Boolean);

    let html = `
      <div class="page-header">
        <h2>Favorites</h2>
        <p>${favProducts.length} saved products</p>
      </div>
    `;

    if (!favProducts.length) {
      html += `<div class="empty-state"><p>Saved products not found in the current data.</p></div>`;
      container.innerHTML = html;
      return;
    }

    html += `<div class="card" style="padding:0;overflow-x:auto"><table><thead><tr><th>Product</th><th>Brand</th><th>Retailer</th><th></th></tr></thead><tbody>`;

    for (const p of favProducts) {
      html += `
        <tr class="clickable" data-pid="${esc(p.id)}">
          <td><span style="font-weight:500">${esc(p.name)}</span></td>
          <td>${p.brand ? esc(p.brand) : "—"}</td>
          <td><span class="badge badge-${p.retailer}">${p.retailer}</span></td>
          <td><button class="btn btn-sm btn-danger remove-fav" data-pid="${esc(p.id)}">Remove</button></td>
        </tr>
      `;
    }

    html += `</tbody></table></div>`;
    container.innerHTML = html;

    container.querySelectorAll("tr.clickable").forEach(el => {
      el.addEventListener("click", e => {
        if (e.target.closest(".remove-fav")) return;
        location.hash = "product/" + encodeURIComponent(el.dataset.pid);
      });
    });
    container.querySelectorAll(".remove-fav").forEach(el => {
      el.addEventListener("click", e => {
        e.stopPropagation();
        removeFavorite(el.dataset.pid);
        renderFavorites(container);
      });
    });
  } catch (e) {
    container.innerHTML = `<div class="page-header"><h2>Favorites</h2></div><div class="error">${e.message}</div>`;
  }
}