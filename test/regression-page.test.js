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

test('a completed transfer does not switch the microphone off', () => {
  // A sender plays until a person stops it, so what just arrived is still in
  // the air. Stopping the microphone on completion meant the next thing sent
  // - a message after a file - was never heard: pressing Listen received the
  // previous transfer again and stopped the microphone again, on a loop.
  const src = fs.readFileSync(path.join(__dirname, '..', 'earshot.js'), 'utf8');
  const body = src.slice(src.indexOf('function onComplete'), src.indexOf('function onFailed'));
  assert.ok(body.length > 100, 'could not find onComplete');
  assert.ok(!/stopListen\(\)/.test(body), 'onComplete stops listening, so nothing sent after it can arrive');
  assert.ok(/Still listening/.test(body), 'onComplete should say the microphone is still open');
});

test('a locked file is actually marked locked, or Listen will throw it away', () => {
  // rx.locked guards a file that arrived but is still sealed. If nothing
  // ever sets it, the guard in startListen is dead code and mistyping a
  // passphrase then pressing Listen destroys the bytes.
  const src = fs.readFileSync(path.join(__dirname, '..', 'earshot.js'), 'utf8');
  assert.ok(/rx\.locked = true/.test(src), 'nothing ever sets rx.locked, so the guard never fires');
  assert.ok(/rx\.locked && !rx\.fileBytes/.test(src), 'startListen should keep an arrived-but-locked file');
});
