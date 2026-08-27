'use strict';
// Simulated acoustic channel for tests. Deterministic: every random choice
// comes from a seeded xorshift32 generator, never Math.random.

function rng(seed) {
  let s = (seed >>> 0) || 1;
  const next = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
  next.gauss = () => {
    let u = 0;
    while (u === 0) u = next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
  };
  next.int = (n) => Math.floor(next() * n);
  return next;
}

function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

// White noise at the given SNR relative to the RMS of x (full band).
function awgn(x, snrDb, r) {
  const sigma = rms(x) / Math.pow(10, snrDb / 20);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] + sigma * r.gauss();
  return out;
}

function silence(n) { return new Float32Array(n); }

function noise(n, level, r) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = level * r.gauss();
  return out;
}

function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Float32Array(n);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// Prepends n samples of faint noise so the frame does not start at sample 0.
function delay(x, n, r, level) {
  return concat([noise(n, level === undefined ? 1e-3 : level, r), x]);
}

function gain(x, g) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
  return out;
}

function clip(x, level) {
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.max(-level, Math.min(level, x[i]));
  return out;
}

function resampleLinear(x, fsIn, fsOut) {
  const n = Math.floor(x.length * fsOut / fsIn);
  const out = new Float32Array(n);
  const step = fsIn / fsOut;
  for (let i = 0; i < n; i++) {
    const pos = i * step;
    const k = Math.floor(pos);
    const frac = pos - k;
    const a = x[k], b = (k + 1 < x.length) ? x[k + 1] : x[k];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

// Clock offset: the signal was made at fs but is played back at fs*(1+ppm/1e6).
function drift(x, fs, ppm) {
  return resampleLinear(x, fs * (1 + ppm * 1e-6), fs);
}

// First-order high-pass then low-pass, roughly what a laptop speaker and mic do.
function bandpass(x, fs, lo, hi) {
  const out = new Float32Array(x.length);
  const rcH = 1 / (2 * Math.PI * lo), dt = 1 / fs, aH = rcH / (rcH + dt);
  const aL = dt / (1 / (2 * Math.PI * hi) + dt);
  let yH = 0, xPrev = 0, yL = 0;
  for (let i = 0; i < x.length; i++) {
    yH = aH * (yH + x[i] - xPrev);
    xPrev = x[i];
    yL = yL + aL * (yH - yL);
    out[i] = yL;
  }
  return out;
}

// Replaces len samples from start with zeros or with loud noise.
function burst(x, start, len, r, mode) {
  const out = x.slice();
  const level = 2 * rms(x);
  for (let i = start; i < Math.min(x.length, start + len); i++) {
    out[i] = mode === 'noise' ? level * r.gauss() : 0;
  }
  return out;
}

// Multipath: adds delayed, attenuated copies. taps = [[seconds, dB], ...].
// The defaults are a desk reflection and a few wall bounces. Taps that all
// sit at half a period of one tone (e.g. 7/13/23 ms for 1500 Hz) notch that
// tone out completely; that case is a room problem, not a decoder problem.
function echoes(x, fs, taps) {
  taps = taps || [[0.0013, -6], [0.0041, -10], [0.011, -14], [0.019, -18]];
  const out = x.slice();
  for (const [sec, db] of taps) {
    const n = Math.round(sec * fs), g = Math.pow(10, db / 20);
    for (let i = n; i < x.length; i++) out[i] += g * x[i - n];
  }
  return out;
}

// ---- The honest additions the OFDM work needs. `echoes`/`drift` above are
// kept for the FSK tests; these are their better-behaved replacements.
const FFT = require('../../fft.js');

// Clock offset without linear-interpolation damage: the signal was made at
// fs but the other clock runs (1 + ppm/1e6) fast.
function sfo(x, fs, ppm) {
  return FFT.sincResample(x, fs * (1 + ppm * 1e-6), fs);
}

// Multipath with fractional-sample tap delays. taps = [[seconds, dB], ...].
function echoesFrac(x, fs, taps) {
  const out = Float32Array.from(x);
  for (const [sec, db] of taps) {
    const g = Math.pow(10, db / 20);
    const delayed = FFT.fracDelay(x, sec * fs);
    for (let i = 0; i < out.length; i++) out[i] += g * delayed[i];
  }
  return out;
}

// Echo sets. ROOM_MEASURED follows the measured burst decay on the real
// path (20 dB down within 6 ms); ROOM_BAD adds a strong late wall tap that
// lands beyond a 5.33 ms cyclic prefix on purpose.
const ROOM_MEASURED = [[0.0007, -8], [0.0015, -13], [0.0028, -17], [0.0045, -22]];
const ROOM_BAD = ROOM_MEASURED.concat([[0.0117, -15]]);

// RBJ peaking-EQ biquad used as a cut, so notch depth is a parameter
// instead of the bottomless RBJ notch.
function peakingCut(x, fs, f0, depthDb, Q) {
  const A = Math.pow(10, -depthDb / 40);
  const w0 = 2 * Math.PI * f0 / fs, alpha = Math.sin(w0) / (2 * Q), cw = Math.cos(w0);
  const b0 = 1 + alpha * A, b1 = -2 * cw, b2 = 1 - alpha * A;
  const a0 = 1 + alpha / A, a1 = -2 * cw, a2 = 1 - alpha / A;
  const out = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}

// A list of notches: [[freqHz, depthDb, Q], ...].
function notches(x, fs, list) {
  let y = x;
  for (const [f, depth, Q] of list) y = peakingCut(y, fs, f, depth, Q || 8);
  return y;
}

// A comb: notches every `spacingHz` across the band, like the deep
// frequency-selective fading a reflective desk makes.
function comb(x, fs, spacingHz, depthDb, r) {
  const list = [];
  for (let f = spacingHz; f < 0.45 * fs; f += spacingHz) {
    list.push([f + (r ? (r() - 0.5) * 0.2 * spacingHz : 0), depthDb, 8]);
  }
  return notches(x, fs, list);
}

module.exports = { rng, rms, awgn, silence, noise, concat, delay, gain, clip, resampleLinear, drift, bandpass, burst, echoes,
  sfo, echoesFrac, notches, comb, peakingCut, ROOM_MEASURED, ROOM_BAD };
