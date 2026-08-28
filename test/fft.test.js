'use strict';
const test = require('node:test');
const assert = require('node:assert');
const FFT = require('../fft.js');
const { rng } = require('./helpers/channel.js');

function naiveDFT(x) {
  const N = x.length, re = new Float64Array(N), im = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    for (let n = 0; n < N; n++) {
      const a = -2 * Math.PI * k * n / N;
      re[k] += x[n] * Math.cos(a);
      im[k] += x[n] * Math.sin(a);
    }
  }
  return { re, im };
}

test('fft agrees with a naive DFT to 1e-6', () => {
  const N = 64, r = rng(1);
  const x = new Float64Array(N).map(() => r() * 2 - 1);
  const want = naiveDFT(x);
  const re = Float64Array.from(x), im = new Float64Array(N);
  FFT.makeFFT(N)(re, im);
  let maxMag = 0;
  for (let k = 0; k < N; k++) maxMag = Math.max(maxMag, Math.hypot(want.re[k], want.im[k]));
  for (let k = 0; k < N; k++) {
    assert.ok(Math.abs(re[k] - want.re[k]) / maxMag < 1e-6, `re[${k}]`);
    assert.ok(Math.abs(im[k] - want.im[k]) / maxMag < 1e-6, `im[${k}]`);
  }
});

test('Parseval holds at N=1024', () => {
  const N = 1024, r = rng(2);
  const x = new Float64Array(N).map(() => r() * 2 - 1);
  let time = 0;
  for (const v of x) time += v * v;
  const re = Float64Array.from(x), im = new Float64Array(N);
  FFT.makeFFT(N)(re, im);
  let freq = 0;
  for (let k = 0; k < N; k++) freq += re[k] * re[k] + im[k] * im[k];
  assert.ok(Math.abs(freq / N - time) / time < 1e-9, `${freq / N} vs ${time}`);
});

test('ifft round trip', () => {
  const N = 256, r = rng(3);
  const re = new Float64Array(N).map(() => r() * 2 - 1);
  const im = new Float64Array(N).map(() => r() * 2 - 1);
  const re0 = Float64Array.from(re), im0 = Float64Array.from(im);
  FFT.makeFFT(N)(re, im);
  FFT.makeIFFT(N)(re, im);
  for (let k = 0; k < N; k++) {
    assert.ok(Math.abs(re[k] - re0[k]) < 1e-9 && Math.abs(im[k] - im0[k]) < 1e-9, 'k ' + k);
  }
});

test('fft rejects non-power-of-two sizes', () => {
  assert.throws(() => FFT.makeFFT(960));
});

function tone(n, fs, f, amp) {
  return new Float32Array(n).map((_, i) => (amp || 1) * Math.sin(2 * Math.PI * f * i / fs));
}
function goertzelPower(x, fs, f, from, to) {
  const w = 2 * Math.PI * f / fs, coeff = 2 * Math.cos(w);
  let s0 = 0, s1 = 0, s2 = 0, n = 0;
  for (let i = from; i < to; i++) { s0 = x[i] + coeff * s1 - s2; s2 = s1; s1 = s0; n++; }
  return (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (n * n) * 4;
}

test('resampler holds amplitude and frequency through 44.1k -> 48k -> 44.1k', () => {
  const fs = 44100, x = tone(fs, fs, 3000, 0.8);
  const up = FFT.sincResample(x, 44100, 48000);
  const back = FFT.sincResample(up, 48000, 44100);
  const margin = 2000;
  const pIn = goertzelPower(x, fs, 3000, margin, x.length - margin);
  const pOut = goertzelPower(back, fs, 3000, margin, back.length - margin);
  assert.ok(Math.abs(Math.sqrt(pOut / pIn) - 1) < 0.001, 'amplitude ratio ' + Math.sqrt(pOut / pIn));
  // sample-domain error against the original, interior only
  let err = 0, ref = 0;
  for (let i = margin; i < back.length - margin; i++) { const e = back[i] - x[i]; err += e * e; ref += x[i] * x[i]; }
  assert.ok(Math.sqrt(err / ref) < 0.001, 'residual ' + Math.sqrt(err / ref));
});

test('resampler keeps the top of the OFDM band intact', () => {
  const x = tone(48000, 48000, 7453, 0.5);          // top subcarrier
  const y = FFT.sincResample(x, 48000, 44100);
  const p = goertzelPower(y, 44100, 7453, 2000, y.length - 2000);
  assert.ok(Math.abs(Math.sqrt(p) - 0.5) / 0.5 < 0.01, 'amplitude ' + Math.sqrt(p));
});

test('resampler suppresses aliasing images', () => {
  const x = tone(48000, 48000, 21000, 1);           // above the 16 kHz output Nyquist
  const y = FFT.sincResample(x, 48000, 16000);
  const alias = goertzelPower(y, 16000, 21000 - 16000, 500, y.length - 500);   // folds to 5 kHz
  assert.ok(10 * Math.log10(alias + 1e-20) < -50, 'alias at ' + (10 * Math.log10(alias + 1e-20)).toFixed(1) + ' dB');
});

test('fracDelay shifts phase by exactly the requested amount', () => {
  const fs = 48000, f = 1000, d = 10.5;
  const x = tone(fs, fs, f);
  const y = FFT.fracDelay(x, d);
  // measured phase difference via complex correlation over the interior
  let cr = 0, ci = 0;
  for (let i = 1000; i < fs - 1000; i++) {
    const a = 2 * Math.PI * f * i / fs;
    cr += y[i] * Math.sin(a); ci += y[i] * Math.cos(a);
  }
  const measured = Math.atan2(ci, cr);
  const expected = -2 * Math.PI * f * d / fs;
  const wrap = (v) => Math.atan2(Math.sin(v), Math.cos(v));
  assert.ok(Math.abs(wrap(measured - expected)) < 0.01, `phase ${measured} vs ${expected}`);
});

// A capture arriving in chunks used to be resampled one chunk at a time, so
// the filter kernel was truncated at both ends of every chunk and a fraction
// of a sample was lost at each boundary. FFT.Resampler carries the phase and
// the tail across calls; these pin that down.
test('a stream resampled in chunks matches the whole stream, sample for sample', () => {
  const x = tone(48000, 48000, 3000, 0.7);
  for (const [fsIn, fsOut] of [[48000, 44100], [44100, 48000], [22050, 48000], [48000, 16000]]) {
    const whole = FFT.sincResample(x, fsIn, fsOut);
    for (const sizes of [[4096], [128], [1, 127, 4096, 333, 7]]) {
      const r = new FFT.Resampler(fsIn, fsOut);
      const parts = [];
      let pos = 0, k = 0;
      while (pos < x.length) { const n = sizes[k++ % sizes.length]; parts.push(r.process(x.subarray(pos, Math.min(x.length, pos + n)))); pos += n; }
      parts.push(r.flush());
      let total = 0;
      for (const p of parts) total += p.length;
      const cat = new Float32Array(total);
      let off = 0;
      for (const p of parts) { cat.set(p, off); off += p.length; }
      assert.strictEqual(cat.length, whole.length, `${fsIn}->${fsOut} in ${sizes.join('/')}: length`);
      for (let i = 0; i < cat.length; i++) {
        assert.strictEqual(cat[i], whole[i], `${fsIn}->${fsOut} in ${sizes.join('/')}: sample ${i}`);
      }
    }
  }
});

test('the resampler holds the band flat and its output rate exact across chunks', () => {
  const r = new FFT.Resampler(44100, 48000);
  const x = tone(44100 * 2, 44100, 7000, 0.5);   // 2 s at 44.1 kHz
  const parts = [];
  for (let o = 0; o < x.length; o += 4096) parts.push(r.process(x.subarray(o, Math.min(x.length, o + 4096))));
  let n = 0;
  for (const p of parts) n += p.length;
  const y = new Float32Array(n);
  let off = 0;
  for (const p of parts) { y.set(p, off); off += p.length; }
  // 2 s in is 2 s out, to within the kernel's half-width still being held back
  assert.ok(Math.abs(n - 96000) <= 32, 'produced ' + n + ' samples for 2 s at 48 kHz');
  const p = goertzelPower(y, 48000, 7000, 2000, y.length - 2000);
  assert.ok(Math.abs(Math.sqrt(p) - 0.5) / 0.5 < 0.01, 'amplitude ' + Math.sqrt(p));
});
