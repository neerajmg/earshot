'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Ofdm = require('../ofdm.js');
const ch = require('./helpers/channel.js');

const FS = 48000;
const QPSK = [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([a, b]) => [a / Math.SQRT2, b / Math.SQRT2]);

function randomSymbols(n, r) {
  const out = [];
  for (let s = 0; s < n; s++) out.push(Array.from({ length: Ofdm.P.data.length }, () => QPSK[r.int(4)]));
  return out;
}

// mean-square error against what was sent, in dB; optionally only for bins
// the predicate accepts (i is the data-bin index).
function evmDb(sent, rx, accept) {
  let e = 0, n = 0;
  for (let s = 0; s < sent.length; s++) {
    for (let i = 0; i < sent[s].length; i++) {
      if (accept && !accept(i, rx.symbols[s].eq[i][2])) continue;
      const [zr, zi] = rx.symbols[s].eq[i], [tr, ti] = sent[s][i];
      e += (zr - tr) * (zr - tr) + (zi - ti) * (zi - ti); n++;
    }
  }
  return n ? 10 * Math.log10(e / n) : 0;
}

function stats(body) {
  let peak = 0, pow = 0;
  for (const v of body) { peak = Math.max(peak, Math.abs(v)); pow += v * v; }
  return { paprDb: 20 * Math.log10(peak / Math.sqrt(pow / body.length)) };
}

test('loopback with shaping off is numerically transparent', () => {
  const r = ch.rng(1);
  const sent = randomSymbols(12, r);
  const body = Ofdm.txBody(sent, 0.8, { papr: false });
  const rx = Ofdm.rxBody(body, 0, 12);
  const evm = evmDb(sent, rx);
  assert.ok(evm < -40, 'EVM ' + evm.toFixed(1) + ' dB');
});

test('PAPR shaping: under 10.5 dB peak-to-average at an EVM floor near -23 dB', () => {
  const r = ch.rng(2);
  const sent = randomSymbols(12, r);
  const body = Ofdm.txBody(sent, 0.8);
  const { paprDb } = stats(body);
  assert.ok(paprDb < 10.5, 'PAPR ' + paprDb.toFixed(1) + ' dB');
  const shaped = evmDb(sent, Ofdm.rxBody(body, 0, 12));
  assert.ok(shaped < -20 && shaped > -30, 'EVM with shaping ' + shaped.toFixed(1) + ' dB');
  const unshaped = stats(Ofdm.txBody(sent, 0.8, { papr: false })).paprDb;
  assert.ok(unshaped - paprDb > 1.5, 'shaping saves ' + (unshaped - paprDb).toFixed(1) + ' dB of peak');
});

test('a timing error inside the cyclic prefix costs nothing', () => {
  const r = ch.rng(3);
  const sent = randomSymbols(8, r);
  const pad = 4096;
  const x = ch.concat([ch.noise(pad, 1e-6, r), Ofdm.txBody(sent, 0.8, { papr: false }), ch.noise(pad, 1e-6, r)]);
  for (const err of [-48, 0, 48]) {
    const rx = Ofdm.rxBody(x, pad + err, 8);
    const evm = evmDb(sent, rx);
    assert.ok(evm < -30, `offset ${err}: EVM ${evm.toFixed(1)} dB`);
  }
});

test('EVM tracks SNR through white noise', () => {
  const r = ch.rng(4);
  const sent = randomSymbols(12, r);
  const clean = Ofdm.txBody(sent, 0.8, { papr: false });
  const e20 = evmDb(sent, Ofdm.rxBody(ch.awgn(clean, 20, r), 0, 12));
  const e10 = evmDb(sent, Ofdm.rxBody(ch.awgn(clean, 10, r), 0, 12));
  assert.ok(e20 < e10 - 7 && e20 < -10, `20 dB -> ${e20.toFixed(1)}, 10 dB -> ${e10.toFixed(1)}`);
  const gap = e10 - e20;
  assert.ok(gap > 7.5 && gap < 12.5, '10 dB of SNR moved EVM by ' + gap.toFixed(1) + ' dB');
});

test('200 ppm of clock offset is absorbed by pilot slope tracking', () => {
  const r = ch.rng(5);
  const sent = randomSymbols(24, r);
  for (const ppm of [200, -200]) {
    const x = ch.sfo(Ofdm.txBody(sent, 0.8, { papr: false }), FS, ppm);
    const rx = Ofdm.rxBody(x, 0, 24);
    const evm = evmDb(sent, rx);
    assert.ok(evm < -18, `${ppm} ppm: EVM ${evm.toFixed(1)} dB`);
    // and the tracker really is reporting a growing timing slope
    const s0 = Math.abs(rx.symbols[1].slope), s1 = Math.abs(rx.symbols[22].slope);
    assert.ok(s1 > s0, 'slope should grow across the frame');
  }
});

test('echo inside the prefix is equalized away; the notch bins announce themselves', () => {
  const r = ch.rng(6);
  const sent = randomSymbols(12, r);
  const clean = Ofdm.txBody(sent, 0.8, { papr: false });
  const x = ch.awgn(ch.echoesFrac(clean, FS, ch.ROOM_MEASURED), 30, r);
  const rx = Ofdm.rxBody(x, 0, 12);
  const evm = evmDb(sent, rx);
  assert.ok(evm < -18, 'measured room EVM ' + evm.toFixed(1) + ' dB');
});

test('a 20 dB comb: strong bins stay clean, notched bins carry low channel energy', () => {
  const r = ch.rng(7);
  const sent = randomSymbols(12, r);
  const clean = Ofdm.txBody(sent, 0.8, { papr: false });
  const x = ch.awgn(ch.comb(clean, FS, 600, 20, r), 30, r);
  const rx = Ofdm.rxBody(x, 0, 12);
  const hh = rx.symbols[0].eq.map((e) => e[2]);
  const sorted = Array.from(hh).sort((a, b) => a - b);
  const median = sorted[hh.length >> 1];
  assert.ok(sorted[0] < 0.15 * median, 'weakest bin at ' + (sorted[0] / median).toFixed(3) + ' of median: notches must be visible in |H|^2');
  const evmStrong = evmDb(sent, rx, (i, h) => h >= median);
  assert.ok(evmStrong < -18, 'strong-bin EVM ' + evmStrong.toFixed(1) + ' dB');
});

test('the late wall tap degrades but does not destroy', () => {
  const r = ch.rng(8);
  const sent = randomSymbols(12, r);
  const clean = Ofdm.txBody(sent, 0.8, { papr: false });
  const x = ch.awgn(ch.echoesFrac(clean, FS, ch.ROOM_BAD), 30, r);
  const evm = evmDb(sent, Ofdm.rxBody(x, 0, 12));
  assert.ok(evm < -10, 'bad room EVM ' + evm.toFixed(1) + ' dB');
});
