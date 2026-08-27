'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Modem = require('../modem.js');
const DSP = require('../dsp.js');
const { rng } = require('./helpers/channel.js');

const RATES = [16000, 44100, 48000];

function randomBits(r) { return new Uint8Array(Modem.FRAME.BITS).map(() => (r() < 0.5 ? 0 : 1)); }

test('frame has 672 symbols and the expected sample count', () => {
  const bits = randomBits(rng(1));
  assert.strictEqual(DSP.frameSymbols(bits).length, 672);
  for (const p of Object.values(Modem.PRESETS)) {
    for (const fs of RATES) {
      const x = DSP.modulateFrame(bits, p, fs);
      assert.strictEqual(x.length, Math.round(672 * fs / p.baud) + Math.round(p.gapSec * fs), `${p.name} ${fs}`);
      const noGap = DSP.modulateFrame(bits, p, fs, { gap: false });
      assert.strictEqual(noGap.length, Math.round(672 * fs / p.baud));
    }
  }
});

test('phase is continuous: no sample-to-sample jump larger than the tone slope', () => {
  const bits = randomBits(rng(2));
  for (const p of Object.values(Modem.PRESETS)) {
    for (const fs of RATES) {
      const x = DSP.modulateFrame(bits, p, fs, { gap: false, rampSec: 0 });
      const maxStep = 0.5 * 2 * Math.PI * p.markHz / fs * 1.01;
      for (let i = 1; i < x.length; i++) {
        assert.ok(Math.abs(x[i] - x[i - 1]) <= maxStep, `${p.name} ${fs} jump at ${i}: ${Math.abs(x[i] - x[i - 1])}`);
      }
    }
  }
});

test('each symbol carries its own tone (goertzel)', () => {
  const bits = randomBits(rng(3));
  const syms = DSP.frameSymbols(bits);
  for (const p of Object.values(Modem.PRESETS)) {
    const fs = 48000, sps = fs / p.baud;
    const x = DSP.modulateFrame(bits, p, fs, { gap: false, rampSec: 0 });
    for (let k = 0; k < syms.length; k += 13) {
      const seg = x.subarray(Math.round(k * sps), Math.round((k + 1) * sps));
      const pm = DSP.goertzelPower(seg, fs, p.markHz), ps = DSP.goertzelPower(seg, fs, p.spaceHz);
      if (syms[k]) assert.ok(pm > 20 * ps, `${p.name} symbol ${k} should be mark`);
      else assert.ok(ps > 20 * pm, `${p.name} symbol ${k} should be space`);
    }
  }
});

test('amplitude and ramp are applied', () => {
  const x = DSP.modulateFrame(randomBits(rng(4)), Modem.PRESETS.robust, 48000, { amplitude: 0.3 });
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= 0.3 + 1e-6 && peak > 0.29);
  assert.ok(Math.abs(x[0]) < 1e-6, 'starts from zero');
  assert.ok(Math.abs(x[10]) < 0.05, 'still ramping at sample 10');
});
