import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Synthetic-DOM harness for components/detail-dialog.js — just enough of the
// element interface for that module (el/clear from utils/dom.js, <dialog>
// open/close, event listeners, body append/remove). Zero dependencies.
//
// Deviation from real browsers: the harness fires the `close` event in a
// microtask (real <dialog> queues an element task). Both are asynchronous
// relative to close(), which is what the teardown/guard logic depends on;
// actual event timing is covered by the coordinator's Safari checks.
class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.children = [];
    this.parentNode = null;
    this.className = '';
    this.dataset = {};
    this.style = {};
    this.attrs = {};
    this.listeners = new Map();
    this.innerHTML = '';
    this.open = false;
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  get firstChild() { return this.children[0] || null; }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatch(type, event = {}) {
    for (const fn of [...(this.listeners.get(type) || [])]) {
      fn({ key: type, target: this, preventDefault() {}, ...event });
    }
  }
  // Real <dialog>: close() on a closed dialog throws InvalidStateError, and
  // the close event is asynchronous relative to close().
  showModal() { this.open = true; }
  close() {
    if (!this.open) throw new Error('InvalidStateError: dialog not open');
    this.open = false;
    queueMicrotask(() => this.dispatch('close'));
  }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
}

const flush = () => new Promise(r => setImmediate(r));

function walk(node, fn) {
  fn(node);
  for (const c of [...node.children]) walk(c, fn);
}
function textOf(node) {
  let out = node.tagName === '#text' ? node.attrs.text || '' : '';
  for (const c of node.children) out += textOf(c);
  return out;
}
function findById(root, id) {
  let hit = null;
  walk(root, n => { if (!hit && n.attrs.id === id) hit = n; });
  return hit;
}
function findByText(root, text) {
  // Innermost ELEMENT match: a container's text includes all descendant
  // labels, and the text node itself would otherwise shadow the button that
  // holds the click listener.
  let hit = null;
  walk(root, n => { if (n.tagName !== '#text' && textOf(n).includes(text)) hit = n; });
  return hit;
}

const docListeners = new Map();
globalThis.Node = FakeNode;
globalThis.document = {
  createElement: tag => new FakeNode(tag),
  createTextNode: text => { const n = new FakeNode('#text'); n.attrs.text = text; return n; },
  body: new FakeNode('body'),
  getElementById: id => findById(document.body, id),
  addEventListener: (type, fn) => {
    if (!docListeners.has(type)) docListeners.set(type, []);
    docListeners.get(type).push(fn);
  },
  removeEventListener: (type, fn) => {
    const list = docListeners.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  },
};

const { openDetailDialog } = await import('../../public/components/detail-dialog.js');

const OFFER = {
  productId: 'paknsave:1',
  productName: 'Test Butter',
  retailer: 'paknsave',
  storeName: 'Test store',
  currentCents: 549,
  regularCents: 699,
  observedAt: '2026-09-01T00:00:00Z',
};
const api = {
  productHistory: async () => ({
    points: [
      { at: '2026-08-01T00:00:00Z', cents: 549 },
      { at: '2026-08-05T00:00:00Z', cents: 499 },
    ],
  }),
};

function openDetail() {
  openDetailDialog({ ...OFFER }, api);
  return findById(document.body, 'detail-dialog');
}
async function openHistory() {
  const dialog = openDetail();
  const btn = findByText(dialog, 'View price history');
  btn.dispatch('click');
  await flush(); // detail close event + history fetch + render
  return findById(document.body, 'history-dialog');
}

describe('detail-dialog memory (synthetic DOM)', () => {
  beforeEach(() => {
    document.body.children.length = 0;
    docListeners.clear();
  });

  it('history dialog removes itself from the DOM when closed', async () => {
    const history = await openHistory();
    assert.ok(history, 'history dialog opened');
    assert.equal(findById(document.body, 'history-dialog'), history);
    history.close();
    await flush();
    assert.equal(findById(document.body, 'history-dialog'), null,
      'closed history dialog must not stay attached to <body>');
  });

  it('opening a second history dialog retires the first without dropping the second', async () => {
    const first = await openHistory();
    const second = await openHistory(); // loadHistory closes `first` on the way in
    await flush(); // first's late close event
    assert.equal(findById(document.body, 'history-dialog'), second,
      'the second dialog must still be in the DOM');
    assert.notEqual(first, second);
    second.close();
    await flush();
    assert.equal(findById(document.body, 'history-dialog'), null);
  });

  it('opening a detail dialog over an existing one tears down the old keydown listener', async () => {
    const first = openDetail();
    assert.equal((docListeners.get('keydown') || []).length, 1);
    const second = openDetail(); // existing.close() + remove()
    await flush();
    assert.equal(findById(document.body, 'detail-dialog'), second);
    assert.equal((docListeners.get('keydown') || []).length, 1,
      'exactly one document keydown listener must survive');
    assert.equal(first.parentNode, null);
  });

  it('escape closes the detail dialog and leaves zero keydown listeners', async () => {
    openDetail();
    for (const fn of [...(docListeners.get('keydown') || [])]) {
      fn({ key: 'Escape' });
    }
    await flush();
    assert.equal(findById(document.body, 'detail-dialog'), null);
    assert.equal((docListeners.get('keydown') || []).length, 0);
  });
});
