'use strict';
// The deploy publishes what tools/stage-site.js stages. These check that the
// staging carries every file the pages ask for, and that it notices when one
// is missing -- the failure that used to reach the live page with CI green.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stage, checkDir, referencesIn } = require('../tools/stage-site.js');

test('the staged site has every file the pages reference', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-'));
  try {
    const r = stage(path.join(dir, 'site'));
    assert.deepStrictEqual(r.problems, []);
    assert.ok(r.refs.length >= 15, `only ${r.refs.length} references found; the scanner is not reading the pages`);
    for (const f of ['index.html', 'lab.html', 'worker.js', 'capture-worklet.js', 'manifest.json', 'checks/index.html']) {
      assert.ok(r.files.includes(f), f + ' is not staged');
    }
    for (const f of r.files) assert.ok(!/^(test|tools|docs)\//.test(f), f + ' should not be published');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a module the pages load but the deploy leaves out is caught', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-'));
  try {
    const site = path.join(dir, 'site');
    stage(site);
    fs.rmSync(path.join(site, 'fountain.js'));
    const problems = checkDir(site).problems;
    assert.deepStrictEqual(problems, ['the staged site references fountain.js, which is not in it']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the reference scanner reads script tags, importScripts, worklets and workers', () => {
  assert.deepStrictEqual(referencesIn('index.html', '<script src="a.js"></script><link rel="icon" href="i.svg"><a href="https://x/y">x</a><a href="#top">t</a>'),
    ['a.js', 'i.svg']);
  assert.deepStrictEqual(referencesIn('worker.js', "importScripts('m.js', 'n.js');"), ['m.js', 'n.js']);
  assert.deepStrictEqual(referencesIn('checks/soak.html', "ctx.audioWorklet.addModule('../capture-worklet.js')"), ['capture-worklet.js']);
  assert.deepStrictEqual(referencesIn('earshot.js', "new Worker('worker.js')"), ['worker.js']);
});
