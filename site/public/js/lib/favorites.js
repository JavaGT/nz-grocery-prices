const FAV_KEY = 'nz-grocery-favorites';

export function getFavorites() {
  try {
    return JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
  } catch {
    return [];
  }
}

export function addFavorite(id) {
  const favs = getFavorites();
  if (!favs.includes(id)) {
    favs.push(id);
    localStorage.setItem(FAV_KEY, JSON.stringify(favs));
  }
}

export function removeFavorite(id) {
  localStorage.setItem(FAV_KEY, JSON.stringify(getFavorites().filter((x) => x !== id)));
}

export function isFavorite(id) {
  return getFavorites().includes(id);
}
