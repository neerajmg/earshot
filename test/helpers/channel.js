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

module.exports = { rng, rms, awgn, silence, noise, concat, delay, gain, clip, resampleLinear, drift, bandpass, burst, echoes };
