'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const Fountain = require('../fountain.js');
const { rng } = require('./helpers/channel.js');

test('the PRNG spec matches the committed golden vectors, bit for bit', () => {
  const golden = JSON.parse(fs.readFileSync(__dirname + '/fixtures/fountain-golden.json'));
  for (const g of golden.coeffRows) {
    assert.deepStrictEqual(Array.from(Fountain.coeffRow(g.w, g.id, g.count)), g.words, `coeff (${g.w},${g.id},${g.count})`);
  }
  const blocks = [];
  for (let b = 0; b < golden.droplet.count; b++) blocks.push(new Uint8Array(256).map((_, i) => (b * 37 + i * 11) & 0xFF));
  const d = Fountain.makeDroplet(blocks, golden.droplet.window, golden.droplet.id);
  assert.deepStrictEqual(Array.from(d.subarray(0, 16)), golden.droplet.first16);
});

test('systematic ids are the plain blocks', () => {
  const r = rng(1);
  const bytes = new Uint8Array(3000).map(() => r.int(256));
  const wins = Fountain.makeWindows(bytes);
  assert.strictEqual(wins.length, 1);
  assert.strictEqual(wins[0].count, 12);
  const d5 = Fountain.makeDroplet(wins[0].blocks, 0, 5);
  assert.deepStrictEqual(Array.from(d5), Array.from(wins[0].blocks[5]));
});

function sendThrough(bytes, lossRate, seed, opts) {
  const r = rng(seed);
  const wins = Fountain.makeWindows(bytes);
  const decoders = wins.map((w, i) => new Fountain.WindowDecoder(i, w.count));
  let sent = 0;
  let id = (opts && opts.skipSystematic) ? 100000 : 0;
  for (let round = 0; round < 100000; round++) {
    let allDone = true;
    for (let w = 0; w < wins.length; w++) {
      if (decoders[w].isComplete()) continue;
      allDone = false;
      const d = Fountain.makeDroplet(wins[w].blocks, w, id);
      sent++;
      if (r() >= lossRate) decoders[w].add(id, d);
    }
    if (allDone) break;
    id++;
  }
  const out = new Uint8Array(bytes.length);
  let off = 0;
  for (let w = 0; w < wins.length; w++) {
    const blocks = decoders[w].solve();
    assert.ok(blocks, 'window ' + w + ' incomplete');
    for (const b of blocks) {
      const take = Math.min(b.length, bytes.length - off);
      out.set(b.subarray(0, take), off);
      off += take;
    }
  }
  return { out, sent, received: decoders.reduce((a, d) => a + d.received, 0) };
}

test('a full window rebuilds from purely random combinations with tiny overhead', () => {
  const r = rng(2);
  const bytes = new Uint8Array(256 * 256).map(() => r.int(256));   // one full window
  const res = sendThrough(bytes, 0, 3, { skipSystematic: true });
  assert.deepStrictEqual(Buffer.compare(Buffer.from(res.out), Buffer.from(bytes)), 0);
  assert.ok(res.received <= 256 + 20, 'needed ' + res.received + ' droplets for 256 blocks');
});

test('30 percent loss: the file still lands, air cost close to 1/(1-p)', () => {
  const r = rng(4);
  const bytes = new Uint8Array(200000).map(() => r.int(256));      // 4 windows
  const res = sendThrough(bytes, 0.3, 5);
  assert.deepStrictEqual(Buffer.compare(Buffer.from(res.out), Buffer.from(bytes)), 0);
  const blocks = Math.ceil(200000 / 256);
  const ratio = res.sent / blocks;
  assert.ok(ratio < 1.75, 'sent ' + res.sent + ' droplets for ' + blocks + ' blocks (x' + ratio.toFixed(2) + '; carousel needs ~x3.4 here)');
});

test('50 percent loss still converges', () => {
  const r = rng(6);
  const bytes = new Uint8Array(50000).map(() => r.int(256));
  const res = sendThrough(bytes, 0.5, 7);
  assert.deepStrictEqual(Buffer.compare(Buffer.from(res.out), Buffer.from(bytes)), 0);
});

test('one megabyte decodes within the time budget', () => {
  const r = rng(8);
  const bytes = new Uint8Array(1 << 20).map(() => r.int(256));
  const wins = Fountain.makeWindows(bytes);
  assert.strictEqual(wins.length, 16);
  // worst case for the decoder: no systematic droplets at all
  const t0 = process.hrtime.bigint();
  const decoders = wins.map((w, i) => new Fountain.WindowDecoder(i, w.count));
  for (let w = 0; w < wins.length; w++) {
    let id = 100000;
    while (!decoders[w].isComplete()) decoders[w].add(id, Fountain.makeDroplet(wins[w].blocks, w, id)), id++;
  }
  const solveStart = process.hrtime.bigint();
  const out = new Uint8Array(bytes.length);
  let off = 0;
  for (let w = 0; w < wins.length; w++) for (const b of decoders[w].solve()) { out.set(b, off); off += 256; }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const solveMs = Number(process.hrtime.bigint() - solveStart) / 1e6;
  assert.deepStrictEqual(Buffer.compare(Buffer.from(out), Buffer.from(bytes)), 0);
  assert.ok(ms < 5000, 'decode took ' + ms.toFixed(0) + ' ms (solve ' + solveMs.toFixed(0) + ' ms)');
});

test('empty and sub-block files survive the layer', () => {
  for (const n of [0, 1, 255, 257]) {
    const r = rng(20 + n);
    const bytes = new Uint8Array(n).map(() => r.int(256));
    const res = sendThrough(bytes, 0.2, 30 + n);
    assert.deepStrictEqual(Buffer.compare(Buffer.from(res.out), Buffer.from(bytes)), 0, 'n=' + n);
  }
});
