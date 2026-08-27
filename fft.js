// fft.js -- transform and resampling primitives for the OFDM engine.
//
// Exposes one global, `FFT`, plus module.exports for Node. No DOM, no deps.
// Twiddles and windows are Float64 so the transform agrees with a naive DFT
// to better than 1e-6; callers may pass Float32Array or Float64Array.

(function (root) {
  'use strict';

  const TWO_PI = 2 * Math.PI;

  // In-place radix-2 complex FFT for any power-of-two N.
  //   const fft = FFT.makeFFT(1024);  fft(re, im);
  function makeFFT(N) {
    if (N < 2 || (N & (N - 1)) !== 0) throw new Error('FFT size must be a power of two, got ' + N);
    let bits = 0;
    while ((1 << bits) < N) bits++;
    const cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
    for (let i = 0; i < N / 2; i++) {
      cos[i] = Math.cos(TWO_PI * i / N);
      sin[i] = -Math.sin(TWO_PI * i / N);
    }
    const rev = new Uint32Array(N);
    for (let i = 0; i < N; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      rev[i] = r;
    }
    return function fft(re, im) {
      for (let i = 0; i < N; i++) {
        const j = rev[i];
        if (j > i) {
          let t = re[i]; re[i] = re[j]; re[j] = t;
          t = im[i]; im[i] = im[j]; im[j] = t;
        }
      }
      for (let size = 2; size <= N; size <<= 1) {
        const half = size >> 1, step = N / size;
        for (let start = 0; start < N; start += size) {
          for (let k = 0; k < half; k++) {
            const wr = cos[k * step], wi = sin[k * step];
            const a = start + k, b = a + half;
            const tr = re[b] * wr - im[b] * wi;
            const ti = re[b] * wi + im[b] * wr;
            re[b] = re[a] - tr; im[b] = im[a] - ti;
            re[a] += tr; im[a] += ti;
          }
        }
      }
    };
  }

  // Inverse of makeFFT's transform, including the 1/N scale.
  function makeIFFT(N) {
    const fft = makeFFT(N);
    return function ifft(re, im) {
      for (let i = 0; i < N; i++) im[i] = -im[i];
      fft(re, im);
      for (let i = 0; i < N; i++) { re[i] /= N; im[i] = -im[i] / N; }
    };
  }

  // Windowed-sinc evaluation of x at fractional position t (in samples).
  // fc is the low-pass cutoff in cycles per input sample (0.5 = Nyquist).
  function sampleAt(x, t, halfTaps, fc) {
    const lo = Math.max(0, Math.ceil(t) - halfTaps);
    const hi = Math.min(x.length - 1, Math.floor(t) + halfTaps);
    let acc = 0;
    for (let j = lo; j <= hi; j++) {
      const d = t - j;
      const s = d === 0 ? 2 * fc : Math.sin(TWO_PI * fc * d) / (Math.PI * d);
      const c = Math.PI * d / halfTaps;                        // Blackman window
      const w = 0.42 + 0.5 * Math.cos(c) + 0.08 * Math.cos(2 * c);
      acc += x[j] * s * w;
    }
    return acc;
  }

  // High-quality arbitrary-ratio resampler. Unlike linear interpolation it
  // holds the passband flat (well under 0.1 % ripple below 0.4 fs) and puts
  // aliasing images below about -60 dB, which is what validating an OFDM
  // claim at 200 ppm of clock offset requires.
  function sincResample(x, fsIn, fsOut, halfTaps) {
    halfTaps = halfTaps || 24;
    const ratio = fsOut / fsIn;
    const n = Math.floor(x.length * ratio);
    const out = new Float32Array(n);
    const fc = 0.46 * Math.min(1, ratio);
    for (let i = 0; i < n; i++) out[i] = sampleAt(x, i / ratio, halfTaps, fc);
    return out;
  }

  // The whole signal delayed by a fractional number of samples.
  function fracDelay(x, delaySamples, halfTaps) {
    halfTaps = halfTaps || 16;
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const t = i - delaySamples;
      if (t >= 0 && t < x.length) out[i] = sampleAt(x, t, halfTaps, 0.46);
    }
    return out;
  }

  const FFT = { makeFFT, makeIFFT, sincResample, fracDelay, sampleAt };
  root.FFT = FFT;
  if (typeof module !== 'undefined' && module.exports) module.exports = FFT;
})(typeof globalThis !== 'undefined' ? globalThis : this);
