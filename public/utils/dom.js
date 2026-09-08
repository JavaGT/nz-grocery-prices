export function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'className') { e.className = v; }
    else if (k === 'dataset') { Object.assign(e.dataset, v); }
    else if (k.startsWith('on')) { e.addEventListener(k.slice(2).toLowerCase(), v); }
    else if (k === 'style' && typeof v === 'object') { Object.assign(e.style, v); }
    else if (k === 'htmlFor') { e.setAttribute('for', v); }
    else { e.setAttribute(k, v); }
  }
  for (const child of children) {
    if (child == null || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      e.appendChild(document.createTextNode(String(child)));
    } else if (child instanceof Node) {
      e.appendChild(child);
    } else if (Array.isArray(child)) {
      child.forEach(c => { if (c instanceof Node) e.appendChild(c); });
    }
  }
  return e;
}

export function qs(sel, ctx = document) { return ctx.querySelector(sel); }
export function qsa(sel, ctx = document) { return Array.from(ctx.querySelectorAll(sel)); }

export function show(el) { if (el) el.classList.remove('hide'); }
export function hide(el) { if (el) el.classList.add('hide'); }

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
}
