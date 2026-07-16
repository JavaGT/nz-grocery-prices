import { api } from "../api.js";
import { isFavorite } from "../favorites-store.js";

const ITEMS_PER_PAGE = 42;

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }
function d(iso) { return new Date(iso).toLocaleDateString("en-NZ", { month: "short", day: "numeric" }); }

export async function renderBrowse(container) {
  container.innerHTML = `<div class="loading">Loading products…</div>`;

  try {
    const [allData, stores] = await Promise.all([api.products(), api.stores()]);
    const all = allData.products;
    const retailers = [...new Set(stores.map(s => s.retailer))].sort();
    let filtered = all;
    let currentPage = 0;
    let searchQuery = "";
    let retailerFilter = "";

    function render() {
      let list = filtered;
      if (retailerFilter) list = list.filter(p => p.retailer === retailerFilter);
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        list = list.filter(p => p.name.toLowerCase().includes(q) || (p.brand && p.brand.toLowerCase().includes(q)));
      }

      const total = list.length;
      const pages = Math.ceil(total / ITEMS_PER_PAGE);
      if (currentPage >= pages) currentPage = Math.max(0, pages - 1);
      const offset = currentPage * ITEMS_PER_PAGE;
      const page = list.slice(offset, offset + ITEMS_PER_PAGE);

      let html = `
        <div class="page-header">
          <h2>Browse products</h2>
          <p>${total} products</p>
        </div>
        <div class="filter-bar">
          <input type="text" id="search-input" placeholder="Search products…" value="${esc(searchQuery)}">
          <select id="retailer-filter">
            <option value="">All retailers</option>
            ${retailers.map(r => `<option value="${r}"${r === retailerFilter ? " selected" : ""}>${r}</option>`).join("")}
          </select>
        </div>
        <div class="card" style="padding:0;overflow-x:auto">
          <table>
            <thead><tr><th>Product</th><th>Brand</th><th>Retailer</th><th>Last seen</th></tr></thead>
            <tbody>
              ${page.map(p => `
                <tr class="clickable" data-pid="${esc(p.id)}">
                  <td><span style="font-weight:500">${esc(p.name)}${isFavorite(p.id) ? ' <span style="color:#dc2626">♥</span>' : ""}</span></td>
                  <td>${p.brand ? esc(p.brand) : "—"}</td>
                  <td><span class="badge badge-${p.retailer}">${p.retailer}</span></td>
                  <td style="color:#888;font-size:13px">${d(p.lastSeen)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      `;

      if (pages > 1) {
        html += `<div class="pagination">`;
        html += `<button ${currentPage === 0 ? "disabled" : ""} data-page="${currentPage - 1}">← Prev</button>`;
        for (let i = 0; i < pages; i++) {
          html += `<button class="${i === currentPage ? "active" : ""}" data-page="${i}">${i + 1}</button>`;
        }
        html += `<button ${currentPage >= pages - 1 ? "disabled" : ""} data-page="${currentPage + 1}">Next →</button>`;
        html += `</div>`;
      }

      if (!page.length) {
        html += `<div class="empty-state"><p>No products match your search.</p></div>`;
      }

      container.innerHTML = html;

      document.getElementById("search-input").addEventListener("input", e => {
        searchQuery = e.target.value;
        currentPage = 0;
        render();
      });
      document.getElementById("retailer-filter").addEventListener("change", e => {
        retailerFilter = e.target.value;
        currentPage = 0;
        render();
      });
      container.querySelectorAll("[data-page]").forEach(el => {
        el.addEventListener("click", () => { currentPage = Number(el.dataset.page); render(); });
      });
      container.querySelectorAll("tr.clickable").forEach(el => {
        el.addEventListener("click", () => location.hash = "product/" + encodeURIComponent(el.dataset.pid));
      });
    }

    render();
  } catch (e) {
    container.innerHTML = `<div class="error">Failed to load products: ${e.message}</div>`;
  }
}