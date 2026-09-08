// Tests for tools/build-assets.js — the content-hashed asset build. Runs the
// CLI against a fixture source dir and pins the contract the server relies
// on: deterministic hashes, rewritten import specifiers, rewritten
// index.html, manifest, and stale-file cleanup.

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'build-assets.js');

function run(src, out) {
  execFileSync(process.execPath, [SCRIPT, '--src', src, '--out', out]);
}

function fixture() {
  const src = mkdtempSync(join(tmpdir(), 'assets-src-'));
  writeFileSync(join(src, 'index.html'), `
<link rel="stylesheet" href="/style.css">
<link rel="modulepreload" href="/utils/dom.js">
<script type="module" src="/app.js"></script>`);
  writeFileSync(join(src, 'style.css'), 'body { color: red; }');
  writeFileSync(join(src, 'app.js'), "import { api } from './api.js';\nimport { el } from './utils/dom.js';\nconsole.log(api, el);\n");
  writeFileSync(join(src, 'api.js'), "export const api = {};\n");
  const utils = join(src, 'utils');
  mkdirSync(utils, { recursive: true });
  writeFileSync(join(utils, 'dom.js'), "export const el = () => {};\n");
  return src;
}

describe('build-assets (content-hashed dist)', () => {
  const src = fixture();
  const out = mkdtempSync(join(tmpdir(), 'assets-out-'));
  after(() => {
    rmSync(src, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  it('emits hashed files, rewritten imports, rewritten html, and a manifest', () => {
    run(src, out);
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));

    assert.deepEqual(Object.keys(manifest).sort(),
      ['api.js', 'app.js', 'index.html', 'style.css', 'utils/dom.js']);

    const appHashed = manifest['app.js'];
    assert.match(appHashed, /^app\.[0-9a-f]{10}\.js$/);
    const appContent = readFileSync(join(out, appHashed), 'utf8');
    assert.match(appContent, /from ['"]\.\/api\.[0-9a-f]{10}\.js['"]/,
      'import specifier rewritten to hashed sibling');
    assert.match(appContent, /from ['"]\.\/utils\/dom\.[0-9a-f]{10}\.js['"]/,
      'import specifier rewritten to hashed subdirectory module');

    const html = readFileSync(join(out, 'index.html'), 'utf8');
    assert.match(html, /href="\/style\.[0-9a-f]{10}\.css"/);
    assert.match(html, /src="\/app\.[0-9a-f]{10}\.js"/);
    assert.match(html, /href="\/utils\/dom\.[0-9a-f]{10}\.js"/);
    assert.equal(html.includes('href="/style.css"'), false, 'no unhashed refs remain');
    assert.equal(html.includes('src="/app.js"'), false, 'no unhashed script ref remains');

    // Entry stays unhashed (it is the no-cache document that resolves hashes).
    assert.ok(readdirSync(out).includes('index.html'));
  });

  it('is deterministic: rebuilding produces identical hashes', () => {
    const before = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    run(src, out);
    const after = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    assert.deepEqual(after, before);
  });

  it('removes stale files from previous builds', () => {
    const stale = join(out, 'app.deadbeef00.js');
    writeFileSync(stale, 'console.log("stale");\n');
    run(src, out);
    assert.equal(readdirSync(out).includes('app.deadbeef00.js'), false,
      'stale hashed file must be cleaned');
  });

  it('emits precompressed .br/.gz siblings that decode to the original', () => {
    run(src, out);
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    for (const rel of ['style.css', 'app.js', 'index.html']) {
      const hashed = manifest[rel];
      const raw = readFileSync(join(out, hashed));
      const br = readFileSync(join(out, hashed + '.br'));
      const gz = readFileSync(join(out, hashed + '.gz'));
      assert.deepEqual(brotliDecompressSync(br), raw, `${rel}.br decodes to ${rel}`);
      assert.deepEqual(gunzipSync(gz), raw, `${rel}.gz decodes to ${rel}`);
    }
  });
});
