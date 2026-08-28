#!/usr/bin/env node
// Stages exactly what GitHub Pages publishes, then refuses to hand over a
// site that is missing something the pages ask for.
//
//   node tools/stage-site.js site
//
// The deploy used to name every file on one `cp` line. A new module pulled in
// by index.html, or added to worker.js's importScripts, shipped a broken page
// while CI stayed green -- the tests served the repository root, where the
// file was there all along. So: copy the whole tree except the directories
// that are for developing rather than for visitors, then walk every local
// reference the staged pages make and check it against what was copied.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

// Everything else ships. A new page, icon or module needs no edit here.
const SKIP = new Set(['.github', '.claude', 'docs', 'test', 'tools', 'node_modules',
  'package.json', 'package-lock.json', 'eval-results.md', 'eval-ofdm.md', 'CLAUDE.md']);

function copyTree(src, dest, rel) {
  fs.mkdirSync(dest, { recursive: true });
  const out = [];
  for (const name of fs.readdirSync(src)) {
    if (name.startsWith('.') || SKIP.has(rel ? rel + '/' + name : name)) continue;
    const from = path.join(src, name), to = path.join(dest, name);
    const r = rel ? rel + '/' + name : name;
    if (fs.statSync(from).isDirectory()) out.push(...copyTree(from, to, r));
    else { fs.copyFileSync(from, to); out.push(r); }
  }
  return out;
}

// Every local file a page names: script and link and image targets, page
// links, importScripts, audioWorklet.addModule, new Worker, and the icons in
// a web app manifest.
function referencesIn(file, text) {
  const refs = [];
  const add = (u) => {
    if (!u) return;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(u)) return;         // http:, data:, mailto:, protocol-relative, anchor
    const clean = u.split(/[?#]/)[0];
    if (!clean || clean.endsWith('/')) return;                     // a directory serves its index.html
    refs.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), clean)));
  };
  if (file.endsWith('.html')) {
    for (const m of text.matchAll(/<(?:script|img|source)\b[^>]*\bsrc\s*=\s*"([^"]*)"/gi)) add(m[1]);
    for (const m of text.matchAll(/<(?:link|a)\b[^>]*\bhref\s*=\s*"([^"]*)"/gi)) add(m[1]);
  }
  if (file.endsWith('.html') || file.endsWith('.js')) {
    for (const m of text.matchAll(/importScripts\s*\(([^)]*)\)/g)) for (const q of m[1].matchAll(/'([^']*)'|"([^"]*)"/g)) add(q[1] || q[2]);
    for (const m of text.matchAll(/addModule\s*\(\s*['"]([^'"]+)['"]/g)) add(m[1]);
    for (const m of text.matchAll(/new\s+Worker\s*\(\s*['"]([^'"]+)['"]/g)) add(m[1]);
  }
  if (file.endsWith('manifest.json')) {
    for (const m of text.matchAll(/"src"\s*:\s*"([^"]+)"/g)) add(m[1]);
  }
  return refs;
}

function listFiles(dir, rel) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const r = rel ? rel + '/' + name : name;
    if (fs.statSync(path.join(dir, name)).isDirectory()) out.push(...listFiles(path.join(dir, name), r));
    else out.push(r);
  }
  return out;
}

// Every local reference the pages in `dir` make, and the ones that resolve to
// nothing. This is the part that makes the deploy list impossible to get
// wrong: it reads what is staged, not a list someone maintains.
function checkDir(dir) {
  const files = listFiles(dir, '');
  const have = new Set(files);
  const refs = new Set();
  for (const f of files) {
    if (!/\.(html|js|json)$/.test(f)) continue;
    for (const r of referencesIn(f, fs.readFileSync(path.join(dir, f), 'utf8'))) refs.add(r);
  }
  const problems = [...refs].filter((r) => !have.has(r) && !have.has(r + '/index.html')).sort()
    .map((r) => `the staged site references ${r}, which is not in it`);
  return { files, refs: [...refs].sort(), problems };
}

// Copies the tree into dest, then checks it.
function stage(dest) {
  fs.rmSync(dest, { recursive: true, force: true });
  copyTree(root, dest, '');
  fs.writeFileSync(path.join(dest, '.nojekyll'), '');
  return Object.assign({ dest }, checkDir(dest));
}

module.exports = { stage, checkDir, referencesIn, SKIP };

if (require.main === module) {
  const dest = path.resolve(process.argv[2] || 'site');
  const r = stage(dest);
  console.log(`staged ${r.files.length} files into ${dest}; ${r.refs.length} local references checked`);
  if (r.problems.length) { r.problems.forEach((p) => console.error(p)); process.exit(1); }
}
