'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Ofdm = require('../ofdm.js');
const ch = require('./helpers/channel.js');

const FS = 48000;
const FIELDS = { profile: 2, cp: 1, band: 0, symCount: 72, session: 173, flags: 5 };

function frameWith(fields, extraSymbols, r) {
  const QPSK = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => [a / Math.SQRT2, b / Math.SQRT2]);
  const symbols = Ofdm.sigEncode(fields);
  for (let s = 0; s < extraSymbols; s++) symbols.push(Array.from({ length: Ofdm.P.data.length }, () => QPSK[r.int(4)]));
  return Ofdm.txBody(symbols, 0.8, { papr: false });
}

test('pack/unpack round trip with a good CRC', () => {
  const bits = Ofdm.sigPack(FIELDS);
  assert.strictEqual(bits.length, 44);
  const f = Ofdm.sigUnpack(bits);
  assert.strictEqual(f.crcOk, true);
  for (const k of ['profile', 'cp', 'band', 'symCount', 'session', 'flags']) assert.strictEqual(f[k], FIELDS[k], k);
  // any flipped bit must kill the CRC or change a field
  for (let b = 0; b < 44; b++) {
    const c = Uint8Array.from(bits); c[b] ^= 1;
    const g = Ofdm.sigUnpack(c);
    const same = g.crcOk && ['profile', 'cp', 'band', 'symCount', 'session', 'flags'].every((k) => g[k] === FIELDS[k]);
    assert.ok(!same, 'flip at ' + b + ' went unnoticed');
  }
});

test('signalling decodes from a clean frame', () => {
  const r = ch.rng(1);
  const body = frameWith(FIELDS, 4, r);
  const rx = Ofdm.rxBody(body, 0, 2 + 4);
  const f = Ofdm.sigDecode(rx.symbols.slice(0, 2), rx.noisePow);
  assert.strictEqual(f.crcOk, true);
  assert.strictEqual(f.symCount, 72);
  assert.strictEqual(f.session, 173);
});

test('signalling survives noise at the bottom of the link budget', () => {
  // The weakest data profile wants about 6 dB per subcarrier; the spec
  // point for signalling is 6 dB below that. Per-bin SNR here is roughly
  // full-band + 6 dB (128 occupied bins of 512), so the spec point of
  // 0 dB per subcarrier is -6 dB full band.
  let ok = 0;
  for (let seed = 0; seed < 10; seed++) {
    const r = ch.rng(100 + seed);
    const body = frameWith(FIELDS, 2, r);
    const x = ch.awgn(body, -6, r);
    const rx = Ofdm.rxBody(x, 0, 2);
    const f = Ofdm.sigDecode(rx.symbols.slice(0, 2), rx.noisePow);
    if (f.crcOk && f.symCount === 72 && f.session === 173 && f.profile === 2) ok++;
  }
  assert.ok(ok >= 9, ok + ' of 10 decoded at -6 dB full band');
});

test('signalling survives the comb and the measured room', () => {
  const r = ch.rng(2);
  const body = frameWith(FIELDS, 2, r);
  const x = ch.awgn(ch.comb(ch.echoesFrac(body, FS, ch.ROOM_MEASURED), FS, 600, 20, r), 5, r);
  const rx = Ofdm.rxBody(x, 0, 2);
  const f = Ofdm.sigDecode(rx.symbols.slice(0, 2), rx.noisePow);
  assert.strictEqual(f.crcOk, true);
  assert.strictEqual(f.symCount, 72);
});

test('garbage in produces crcOk false, never a fake field set', () => {
  let falseOk = 0;
  for (let seed = 0; seed < 20; seed++) {
    const r = ch.rng(200 + seed);
    const x = ch.noise(Math.round((2 + 1) * 1280 + 288 + 4096), 0.3, r);
    const rx = Ofdm.rxBody(x, 0, 2);
    const f = Ofdm.sigDecode(rx.symbols.slice(0, 2), rx.noisePow);
    if (f.crcOk) falseOk++;
  }
  assert.strictEqual(falseOk, 0, falseOk + ' of 20 noise frames produced a valid CRC');
});
