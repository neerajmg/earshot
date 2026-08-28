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
  assert.strictEqual(done.nameHidden, true, 'the name is inside the ciphertext');
  assert.strictEqual(done.name, '', 'the completed message must not leak the name');
  assert.ok(out.filter((m) => m.type === 'frame').every((m) => !m.manifest || m.manifest.name === ''));
  await handle({ type: 'file' });
  assert.ok(out.find((m) => m.type === 'fileError' && m.needsPassphrase));
  await handle({ type: 'file', passphrase: 'nope' });
  assert.ok(out.find((m) => m.type === 'fileError' && /wrong passphrase/.test(m.message)));
  await handle({ type: 'file', passphrase: 'pw' });
  const file = out.filter((m) => m.type === 'file').pop();
  assert.ok(file, 'no file after the right passphrase');
  assert.strictEqual(file.name, 's.txt', 'the name arrives with the unlocked file');
  assert.strictEqual(Buffer.compare(Buffer.from(new Uint8Array(file.bytes)), Buffer.from(bytes)), 0);
});

test('a capture that is not 48 kHz is resampled in the worker, once for the whole stream', async () => {
  const FFT = require('../fft.js');
  const out = [];
  const handle = createWorkerCore((m) => out.push(m));
  await handle({ type: 'init', fs: 48000, inputRate: 44100 });
  assert.strictEqual(out[0].inputRate, 44100);
  const r = ch.rng(3);
  const bytes = new TextEncoder().encode('through a 44.1 kHz microphone. '.repeat(60));
  const prep = await Air.prepare(bytes, 'slow-clock.txt');
  const tx = new Air.Sender(prep, { session: 7, papr: false });
  // What a 44.1 kHz device hands the page: the whole stream at 44.1 k, cut
  // into capture-sized chunks.
  const parts = [];
  for (let i = 0; i < 12; i++) { parts.push(ch.noise(800, 1e-4, r)); parts.push(tx.nextFrame()); }
  let n = 0;
  for (const p of parts) n += p.length;
  const air = new Float32Array(n);
  let off = 0;
  for (const p of parts) { air.set(p, off); off += p.length; }
  const mic = FFT.sincResample(air, 48000, 44100);
  for (let o = 0; o < mic.length && !out.some((m) => m.type === 'complete'); o += 4096) {
    await handle({ type: 'push', buf: mic.slice(o, Math.min(mic.length, o + 4096)).buffer });
  }
  const done = out.find((m) => m.type === 'complete');
  assert.ok(done, 'a 44.1 kHz capture did not complete');
  await handle({ type: 'file' });
  const file = out.filter((m) => m.type === 'file').pop();
  assert.strictEqual(Buffer.compare(Buffer.from(new Uint8Array(file.bytes)), Buffer.from(bytes)), 0);
  const frames = out.filter((m) => m.type === 'frame');
  assert.strictEqual(frames[frames.length - 1].stats.sigFail, 0, 'chunk-edge damage: some frames failed signalling');
});

test('a throw inside the receiver comes back as {type:\'error\'}, never silence', async () => {
  // The core catches and posts; before it, the page kept saying
  // "Listening..." forever while the worker sat dead.
  const out = [];
  const handle = createWorkerCore((m) => out.push(m));
  await handle({ type: 'init', fs: 48000 });
  const orig = Air.Receiver.prototype.push;
  Air.Receiver.prototype.push = () => { throw new Error('boom'); };
  try {
    await handle({ type: 'push', buf: new Float32Array(128).buffer });
  } finally { Air.Receiver.prototype.push = orig; }
  const err = out.find((m) => m.type === 'error');
  assert.ok(err, 'a throw in the receiver produced no error message');
  assert.match(err.message, /boom/);
  assert.strictEqual(err.where, 'push');
});
