'use strict';
// Drives the worker's message loop without a Worker: same code path the
// browser runs, minus postMessage.
const test = require('node:test');
const assert = require('node:assert');
require('../air.js');                                  // registers globals the worker core reads
const { createWorkerCore } = require('../worker.js');
const Air = require('../air.js');
const ch = require('./helpers/channel.js');

test('the worker core carries a transfer end to end, messages only', async () => {
  const out = [];
  const handle = createWorkerCore((m) => out.push(m));
  await handle({ type: 'init', fs: 48000 });
  assert.strictEqual(out[0].type, 'status');

  const r = ch.rng(1);
  const bytes = new Uint8Array(6000).map(() => r.int(256));
  const prep = await Air.prepare(bytes, 'via-worker.bin');
  const tx = new Air.Sender(prep, { session: 4, papr: false });
  let guard = 0;
  while (!out.some((m) => m.type === 'complete') && guard++ < 30) {
    const f = tx.nextFrame();
    const noise = ch.noise(800, 1e-4, r);
    await handle({ type: 'push', buf: noise.buffer });
    await handle({ type: 'push', buf: f.buffer.slice(0) });
  }
  const done = out.find((m) => m.type === 'complete');
  assert.ok(done, 'no complete message');
  assert.strictEqual(done.name, 'via-worker.bin');
  assert.strictEqual(done.crcOk, true);
  assert.strictEqual(done.needsPassphrase, false);
  const frames = out.filter((m) => m.type === 'frame');
  assert.ok(frames.length >= 2, 'progress frames flowed');
  assert.ok(frames[frames.length - 1].progress === 1);

  await handle({ type: 'file' });
  const file = out.find((m) => m.type === 'file');
  assert.ok(file, 'no file message');
  assert.strictEqual(Buffer.compare(Buffer.from(new Uint8Array(file.bytes)), Buffer.from(bytes)), 0);
});

test('an encrypted transfer asks for the passphrase through messages', async () => {
  const out = [];
  const handle = createWorkerCore((m) => out.push(m));
  await handle({ type: 'init', fs: 48000 });
  const r = ch.rng(2);
  const bytes = new TextEncoder().encode('attack at dawn. '.repeat(200));
  const prep = await Air.prepare(bytes, 's.txt', { passphrase: 'pw' });
  const tx = new Air.Sender(prep, { session: 5, papr: false });
  let guard = 0;
  while (!out.some((m) => m.type === 'complete') && guard++ < 30) {
    await handle({ type: 'push', buf: ch.noise(800, 1e-4, r).buffer });
    await handle({ type: 'push', buf: tx.nextFrame().buffer.slice(0) });
  }
  const done = out.find((m) => m.type === 'complete');
  assert.ok(done && done.needsPassphrase, 'needsPassphrase should be set');
  await handle({ type: 'file' });
  assert.ok(out.find((m) => m.type === 'fileError' && m.needsPassphrase));
  await handle({ type: 'file', passphrase: 'nope' });
  assert.ok(out.find((m) => m.type === 'fileError' && /wrong passphrase/.test(m.message)));
  await handle({ type: 'file', passphrase: 'pw' });
  const file = out.filter((m) => m.type === 'file').pop();
  assert.ok(file, 'no file after the right passphrase');
  assert.strictEqual(Buffer.compare(Buffer.from(new Uint8Array(file.bytes)), Buffer.from(bytes)), 0);
});
