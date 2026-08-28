'use strict';
// Three page-level defects that no headless run would catch cheaply, so
// they are pinned by reading earshot.js. Source assertions, nothing else:
// no DOM, no Chrome, no audio.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'earshot.js'), 'utf8');

test('M4: the page does not trim either passphrase box', () => {
  // The sender trimmed and the unlock box did not, so "open sesame " locked
  // a file that "open sesame " could never open.
  assert.ok(!/txPass\.value\.trim\(\)/.test(src),
    'earshot.js trims the sending passphrase; the receiver does not, so a trailing space locks the file out');
  assert.ok(!/rxPass\.value\.trim\(\)/.test(src),
    'earshot.js trims the unlock passphrase');
  assert.ok(/ui\.txPass\.value/.test(src) && /ui\.rxPass\.value/.test(src),
    'both passphrase boxes should still be read');
});

test('H3: the page takes its airtime estimate from Air.framesFor', () => {
  // Two copies of the formula is how the estimate came to be half the truth
  // for a file one byte over a window.
  assert.ok(/Air\.framesFor\(/.test(src),
    'earshot.js carries its own frame estimate instead of calling Air.framesFor');
  assert.ok(!/function framesFor\s*\(/.test(src),
    'earshot.js still defines a second framesFor; there must be one formula');
});

test('the page can start a second transfer: it resets the worker', () => {
  assert.ok(/type:\s*'reset'/.test(src),
    'earshot.js never posts {type:"reset"}, so a second listen reuses the finished receiver');
});
