const currencyFmt = new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD', minimumFractionDigits: 2 });
const dateFmt = new Intl.DateTimeFormat('en-NZ', { month: 'short', day: 'numeric', year: 'numeric' });
const shortDateFmt = new Intl.DateTimeFormat('en-NZ', { month: 'short', day: 'numeric' });

export function formatCents(cents) {
  if (cents == null) return '';
  return currencyFmt.format(cents / 100);
}

export function formatDate(iso) {
  if (!iso) return '';
  return dateFmt.format(new Date(iso));
}

export function formatShortDate(iso) {
  if (!iso) return '';
  return shortDateFmt.format(new Date(iso));
}

export function formatRelativeTime(epochMs) {
  if (!epochMs) return '';
  const diff = Date.now() - epochMs;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return formatDate(new Date(epochMs).toISOString());
}

export function formatDropPercent(current, regular) {
  if (regular == null || regular <= 0 || current == null) return null;
  return Math.round((1 - current / regular) * 100);
}

export function freshnessLevel(observedAt) {
  if (!observedAt) return 'none';
  const age = Date.now() - (typeof observedAt === 'number' ? observedAt : new Date(observedAt).getTime());
  const days = age / 86400000;
  if (days <= 7) return 'fresh';
  if (days <= 14) return 'stale';
  return 'old';
}

export function retailerColor(retailer) {
  const map = {
    paknsave: '#125b39',
    newworld: '#d71920',
    woolworths: '#0b55a2',
    freshchoice: '#6b21a8',
    warehouse: '#ec2334',
  };
  return map[retailer] || '#637168';
}

export function retailerLabel(retailer) {
  const map = {
    paknsave: "PAK'nSAVE",
    newworld: 'New World',
    woolworths: 'Woolworths',
    freshchoice: 'FreshChoice',
    warehouse: 'The Warehouse',
  };
  return map[retailer] || retailer;
}
