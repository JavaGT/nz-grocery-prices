#!/usr/bin/env node
// Content-hashes public/ into public-dist/ so static assets can be served
// with cache-control: immutable (src/app/server.js prefers public-dist when
// it exists). Zero dependencies, deterministic output: the same sources
// always produce the same hashed names.
//
// Usage: node tools/build-assets.js [--src <dir>] [--out <dir>]
//   Defaults: --src <repo>/public --out <repo>/public-dist
//
// What it does:
//   - copies every asset under public/ to the output dir, renaming to
//     <name>.<hash10>.<ext> where hash = sha256 of the FINAL content
//     (after import-specifier rewriting, so a change anywhere in an import
//     chain re-hashes every importer),
//   - rewrites ES-module import specifiers between hashed files,
//   - rewrites index.html references (stylesheet, modulepreload, script src)
//     to the hashed URLs,
//   - writes manifest.json mapping original -> hashed public paths,
//   - removes stale files from previous builds.

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, extname, relative, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const argOf = (name, def) => {
  let i = args.indexOf(name);
  return i >= 0 ? resolve(args[++i]) : def;
};
const SRC = argOf('--src', join(ROOT, 'public'));
const OUT = argOf('--out', join(ROOT, 'public-dist'));

if (!existsSync(SRC)) {
  console.error(`build-assets: source dir ${SRC} does not exist`);
  process.exit(1);
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk(SRC).map(f => relative(SRC, f).split('\\').join('/'));
if (!files.includes('index.html')) {
  console.error('build-assets: public/index.html missing — nothing to build');
  process.exit(1);
}

// ES-module import specifiers that point at repo assets: `from './x.js'`,
// `import './x.js'`, `export ... from './x.js'`.
const IMPORT_RE = /(\bimport\s+|\bfrom\s+)(["'])(\.[^'"]+\.js)\2/g;

function resolveSpecifier(fromRelFile, spec) {
  const dir = posix.dirname(fromRelFile === 'index.html' ? '' : fromRelFile.split('\\').join('/'));
  return posix.normalize(dir ? `${dir}/${spec}` : spec.replace(/^\.\//, ''));
}

// Dependency graph between JS files (imports only; index.html is the entry).
const depsOf = new Map();
for (const rel of files) {
  if (extname(rel) !== '.js') continue;
  const content = readFileSync(join(SRC, rel), 'utf8');
  const deps = [];
  for (const m of content.matchAll(IMPORT_RE)) {
    const target = resolveSpecifier(rel, m[3]);
    if (files.includes(target)) deps.push(target);
  }
  depsOf.set(rel, [...new Set(deps)].sort());
}

// Topological order (dependencies first) so a file is hashed after anything
// it imports; cycles would be a bug in the module graph.
const done = new Set();
const order = [];
function visit(rel, chain) {
  if (done.has(rel)) return;
  if (chain.has(rel)) throw new Error(`cyclic ES-module import: ${[...chain, rel].join(' -> ')}`);
  chain.add(rel);
  for (const dep of depsOf.get(rel) ?? []) visit(dep, chain);
  chain.delete(rel);
  done.add(rel);
  order.push(rel);
}
// index.html is the entry: it is copied verbatim (with rewritten URLs) at
// the end, never emitted under a hashed name.
for (const rel of files) if (rel !== 'index.html') visit(rel, new Set());

const hashName = new Map(); // rel -> hashed rel
function hashedRel(rel, content) {
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 10);
  const dir = posix.dirname(rel);
  const ext = extname(rel);
  const base = posix.basename(rel, ext);
  return dir === '.' ? `${base}.${hash}${ext}` : `${dir}/${base}.${hash}${ext}`;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const manifest = {};
for (const rel of order) {
  if (rel === 'index.html') continue;
  let content = readFileSync(join(SRC, rel), 'utf8');
  // Rewrite import specifiers to the already-hashed dependency names.
  content = content.replace(IMPORT_RE, (whole, head, quote, spec) => {
    const target = resolveSpecifier(rel, spec);
    const hashed = hashName.get(target);
    return hashed ? `${head}${quote}${posix.relative(posix.dirname(rel), hashed)
      .split('\\').join('/').replace(/^(?!\.\.\/)/, './')}${quote}` : whole;
  });
  const outRel = hashedRel(rel, content);
  hashName.set(rel, outRel);
  manifest[rel] = outRel;
  mkdirSync(dirname(join(OUT, outRel)), { recursive: true });
  writeFileSync(join(OUT, outRel), content);
}

// index.html: swap every asset URL for its hashed URL. Longest first so a
// name that prefixes another (none today) cannot shadow it.
let html = readFileSync(join(SRC, 'index.html'), 'utf8');
for (const [rel, outRel] of [...Object.entries(manifest)]
  .sort((a, b) => b[0].length - a[0].length)) {
  html = html.split(`/${rel}`).join(`/${outRel}`);
}
writeFileSync(join(OUT, 'index.html'), html);
manifest['index.html'] = 'index.html';
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`build-assets: ${Object.keys(manifest).length - 1} assets -> ${OUT}`);
for (const [rel, outRel] of Object.entries(manifest)) {
  if (rel !== 'index.html') console.log(`  ${rel} -> ${outRel}`);
}
