'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Fec = require('../fec.js');
const { rng } = require('./helpers/channel.js');

function bpskLlrs(coded, ebN0Db, r) {
  // rate 1/2: energy per coded bit is half the energy per info bit
  const esN0 = Math.pow(10, (ebN0Db - 3.01) / 10);
  const sigma = Math.sqrt(1 / (2 * esN0));
  const out = new Float64Array(coded.length);
  for (let i = 0; i < coded.length; i++) {
    const tx = coded[i] ? -1 : 1;
    const y = tx + sigma * r.gauss();
    out[i] = 2 * y / (sigma * sigma);
  }
  return out;
}

function berAt(ebN0Db, totalBits, r) {
  let errors = 0, sent = 0;
  while (sent < totalBits) {
    const n = 2000;
    const bits = new Uint8Array(n).map(() => r.int(2));
    const coded = Fec.encode(bits);
    const got = Fec.decode(bpskLlrs(coded, ebN0Db, r), n);
    for (let i = 0; i < n; i++) if (got[i] !== bits[i]) errors++;
    sent += n;
  }
  return errors / sent;
}

test('encode/decode round trip, clean', () => {
  const r = rng(1);
  const bits = new Uint8Array(500).map(() => r.int(2));
  const coded = Fec.encode(bits);
  assert.strictEqual(coded.length, 2 * (500 + 6));
  const llrs = Float64Array.from(coded, (b) => (b ? -8 : 8));
  assert.deepStrictEqual(Array.from(Fec.decode(llrs, 500)), Array.from(bits));
});

test('the BER curve sits where the textbook K=7 curve sits', () => {
  const r = rng(2);
  // Literature soft-decision (133,171): about 1e-3 at 3 dB, 1e-4 near
  // 4.2 dB, 1e-5 near 5 dB. Statistical gates with margin:
  const b3 = berAt(3.0, 60000, r);
  assert.ok(b3 < 4e-3 && b3 > 1e-5, 'BER at 3 dB: ' + b3);
  const b45 = berAt(4.5, 120000, r);
  assert.ok(b45 < 4e-4, 'BER at 4.5 dB: ' + b45);
  const b6 = berAt(6.0, 120000, r);
  assert.ok(b6 < 2e-5, 'BER at 6 dB: ' + b6);
  // and the coding gain is real: uncoded BPSK at 6 dB is 2.4e-3
  assert.ok(b6 < 2.4e-3 / 20, 'coding gain against uncoded at 6 dB');
});

test('hard erasures: 18 percent of the frame silenced, zero errors', () => {
  const r = rng(3);
  const nInfo = 8346;                                 // one 72-symbol frame
  const bits = new Uint8Array(nInfo).map(() => r.int(2));
  const coded = Fec.encode(bits);
  const L = coded.length;
  const map = Fec.interleaveMap(L);
  const air = Fec.interleave(Float64Array.from(coded, (b) => (b ? -6 : 6)), map);
  // model the frame as symbols x bins: 72 symbols x 232 coded bits/symbol
  const perSym = 232;
  const nSym = Math.ceil(L / perSym);
  // kill 12 contiguous "bins" (coded-bit lanes) in every symbol...
  for (let s = 0; s < nSym; s++) {
    for (let lane = 40; lane < 64; lane++) {          // 24 lanes = 12 QPSK bins
      const i = s * perSym + lane;
      if (i < L) air[i] = 0;
    }
  }
  // ...and 6 contiguous whole symbols
  for (let s = 30; s < 36; s++) {
    for (let lane = 0; lane < perSym; lane++) {
      const i = s * perSym + lane;
      if (i < L) air[i] = 0;
    }
  }
  const got = Fec.decode(Fec.deinterleave(air, map), nInfo);
  let errors = 0;
  for (let i = 0; i < nInfo; i++) if (got[i] !== bits[i]) errors++;
  assert.strictEqual(errors, 0, errors + ' info-bit errors after erasures');
});

test('interleaver is a bijection that separates neighbours', () => {
  for (const L of [16704, 16704 - 232, 971 * 4]) {
    const map = Fec.interleaveMap(L);
    const seen = new Uint8Array(L);
    for (let i = 0; i < L; i++) seen[map[i]] = 1;
    assert.ok(seen.every((v) => v === 1), 'bijection at L=' + L);
    let minGap = Infinity;
    for (let i = 1; i < 1000; i++) {
      const g = Math.abs(map[i] - map[i - 1]);
      minGap = Math.min(minGap, Math.min(g, L - g));
    }
    assert.ok(minGap > 200, 'neighbour separation ' + minGap + ' at L=' + L);
  }
});

test('an erasure-only channel still decodes up to heavy loss', () => {
  const r = rng(4);
  const bits = new Uint8Array(2000).map(() => r.int(2));
  const coded = Fec.encode(bits);
  const llrs = Float64Array.from(coded, (b) => (b ? -6 : 6));
  for (let i = 0; i < llrs.length; i++) if (r() < 0.25) llrs[i] = 0;   // 25 % erased
  const got = Fec.decode(llrs, 2000);
  let errors = 0;
  for (let i = 0; i < 2000; i++) if (got[i] !== bits[i]) errors++;
  assert.strictEqual(errors, 0, errors + ' errors at 25 % erasure');
});
