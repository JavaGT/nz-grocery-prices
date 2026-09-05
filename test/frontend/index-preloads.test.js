import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

// Walk the static ES-module import graph rooted at app.js (relative imports
// only; the app has no bare specifiers or dynamic imports).
function moduleGraph(entry) {
  const seen = new Set();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      stack.push(join(dirname(file), m[1]));
    }
  }
  return [...seen];
}

const graph = moduleGraph(join(PUBLIC, 'app.js'))
  .map(f => '/' + posix.join(...f.slice(PUBLIC.length + 1).split('\\')))
  .sort();

const entry = '/app.js';
const hinted = [...readFileSync(join(PUBLIC, 'index.html'), 'utf8')
  .matchAll(/<link rel="modulepreload" href="([^"]+)">/g)]
  .map(m => m[1])
  .sort();

describe('index.html modulepreload hints', () => {
  it('hints every statically-imported module except the entry, and nothing else', () => {
    const expected = graph.filter(f => f !== entry);
    assert.deepEqual(hinted, expected,
      'regenerate hints: every module reachable from app.js needs a hint so first paint does not wait on serial module discovery');
  });

  it('hinted files exist and the entry is loaded as a module script', () => {
    const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
    assert.match(html, /<script type="module" src="\/app\.js">/);
    for (const href of hinted) {
      statSync(join(PUBLIC, href));
    }
  });
});
