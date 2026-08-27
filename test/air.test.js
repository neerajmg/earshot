'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Air = require('../air.js');
const ch = require('./helpers/channel.js');

const FS = 48000;

async function transfer(bytes, name, opts) {
  const o = opts || {};
  const r = ch.rng(o.seed || 1);
  const prep = await Air.prepare(bytes, name);
  const tx = new Air.Sender(prep, { session: 9, papr: o.papr !== undefined ? o.papr : false });
  const rx = new Air.Receiver(FS);
  let sent = 0, delivered = 0;
  const cap = o.cap || 200;
  const progressLog = [];
  while (!rx.result && sent < cap) {
    let f = tx.nextFrame();
    sent++;
    if (o.skipFirst && sent <= o.skipFirst) continue;
    if (o.loss && r() < o.loss) continue;
    if (o.channel) f = o.channel(f, r);
    rx.push(ch.noise(o.gapNoise || 800, 1e-4, r));
    rx.push(f);
    delivered++;
    progressLog.push(rx.progress());
  }
  rx.push(ch.noise(FS, 1e-4, r));
  const file = await rx.file();
  return { rx, file, sent, delivered, prep, progressLog };
}

test('a small random file lands byte-perfect and uncompressed', async () => {
  const r = ch.rng(2);
  const bytes = new Uint8Array(5000).map(() => r.int(256));
  const t = await transfer(bytes, 'clean.bin', { seed: 3 });
  assert.ok(t.file, 'no file');
  assert.strictEqual(t.prep.flags & 1, 0, 'random bytes should not be gzipped');
  assert.strictEqual(Buffer.compare(Buffer.from(t.file.bytes), Buffer.from(bytes)), 0);
  assert.strictEqual(t.file.name, 'clean.bin');
  assert.strictEqual(t.rx.stats.dropletCrcFail, 0);
});

test('compressible content ships compressed and comes back identical', async () => {
  const text = 'the quick brown fox jumps over the lazy dog. '.repeat(700);
  const bytes = new TextEncoder().encode(text);
  const t = await transfer(bytes, 'notes.txt', { seed: 4 });
  assert.strictEqual(t.prep.flags & 1, 1, 'text should compress');
  assert.ok(t.prep.payload.length < bytes.length / 3, 'gzip should earn its keep: ' + t.prep.payload.length);
  assert.strictEqual(Buffer.compare(Buffer.from(t.file.bytes), Buffer.from(bytes)), 0);
});

test('30 percent frame loss: the fountain refills without passes', async () => {
  const r = ch.rng(5);
  const bytes = new Uint8Array(20000).map(() => r.int(256));
  const t = await transfer(bytes, 'lossy.bin', { seed: 6, loss: 0.3, cap: 120 });
  assert.ok(t.file, 'no file after ' + t.sent + ' frames');
  assert.strictEqual(Buffer.compare(Buffer.from(t.file.bytes), Buffer.from(bytes)), 0);
  const minFrames = Math.ceil(Math.ceil(20000 / 256) / Air.DROPLETS_PER_FRAME);
  assert.ok(t.sent < 2.2 * minFrames, `took ${t.sent} frames against a floor of ${minFrames}`);
});

test('a joiner who missed the first frames still gets everything', async () => {
  const r = ch.rng(7);
  const bytes = new Uint8Array(8000).map(() => r.int(256));
  const t = await transfer(bytes, 'late.bin', { seed: 8, skipFirst: 3 });
  assert.ok(t.file, 'no file');
  assert.strictEqual(Buffer.compare(Buffer.from(t.file.bytes), Buffer.from(bytes)), 0);
});

test('the whole chain survives noise, echo, comb and clock offset at once', async () => {
  const r0 = ch.rng(9);
  const bytes = new Uint8Array(12000).map(() => r0.int(256));
  const channel = (f, r) => ch.awgn(ch.comb(ch.sfo(ch.echoesFrac(f, FS, ch.ROOM_MEASURED), FS, 120), FS, 600, 12, r), 8, r);
  const t = await transfer(bytes, 'hard.bin', { seed: 10, channel, cap: 120, papr: true });
  assert.ok(t.file, 'no file: stats ' + JSON.stringify(t.rx.stats));
  assert.strictEqual(Buffer.compare(Buffer.from(t.file.bytes), Buffer.from(bytes)), 0);
});

test('progress is monotone and ends at 1', async () => {
  const r = ch.rng(11);
  const bytes = new Uint8Array(15000).map(() => r.int(256));
  const t = await transfer(bytes, 'prog.bin', { seed: 12, loss: 0.2, cap: 120 });
  assert.ok(t.file);
  for (let i = 1; i < t.progressLog.length; i++) {
    assert.ok(t.progressLog[i] >= t.progressLog[i - 1] - 1e-9, 'progress went backwards at ' + i);
  }
  assert.ok(Math.abs(t.progressLog[t.progressLog.length - 1] - 1) < 1e-9);
});

test('one megabyte through 30 percent loss, byte-perfect', { skip: !process.env.EARSHOT_SLOW && 'set EARSHOT_SLOW=1' }, async () => {
  const r = ch.rng(13);
  const bytes = new Uint8Array(1 << 20).map(() => r.int(256));
  const t = await transfer(bytes, 'big.bin', { seed: 14, loss: 0.3, cap: 4000 });
  assert.ok(t.file, 'no file after ' + t.sent + ' frames');
  assert.strictEqual(Buffer.compare(Buffer.from(t.file.bytes), Buffer.from(bytes)), 0);
  console.log(`      1 MB: ${t.sent} frames sent, ${t.delivered} heard, ` +
    `${(t.sent * (48000 * 0.05 + 75 * 1280 + 720) / 48000 / 60).toFixed(1)} min of air`);
});
