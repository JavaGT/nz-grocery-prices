const KEY = "nz-grocery-favorites";

export function getFavorites() {
  try { return JSON.parse(localStorage.getItem(KEY) || "[]"); }
  catch { return []; }
}

export function addFavorite(productId) {
  const favs = getFavorites();
  if (!favs.includes(productId)) {
    favs.push(productId);
    localStorage.setItem(KEY, JSON.stringify(favs));
  }
}

export function removeFavorite(productId) {
  localStorage.setItem(KEY, JSON.stringify(getFavorites().filter(id => id !== productId)));
}

export function isFavorite(productId) {
  return getFavorites().includes(productId);
}