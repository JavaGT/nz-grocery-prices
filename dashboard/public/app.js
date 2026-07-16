import { renderDeals } from "./views/deals.js";
import { renderProduct } from "./views/product.js";
import { renderBrowse } from "./views/browse.js";
import { renderFavorites } from "./views/favorites.js";
import { renderStats } from "./views/stats.js";

const main = document.getElementById("main-content");

function route() {
  const hash = location.hash.slice(1) || "deals";
  const [view, ...rest] = hash.split("/");
  const param = decodeURIComponent(rest.join("/") || "");

  document.querySelectorAll(".nav-link").forEach(link => {
    const href = link.getAttribute("href").slice(1);
    link.classList.toggle("active", href === view);
  });

  switch (view) {
    case "deals":
      renderDeals(main);
      break;
    case "product":
      if (param) renderProduct(main, param);
      else location.hash = "browse";
      break;
    case "browse":
      renderBrowse(main);
      break;
    case "favorites":
      renderFavorites(main);
      break;
    case "stats":
      renderStats(main);
      break;
    default:
      location.hash = "deals";
  }
}

window.addEventListener("hashchange", route);
route();