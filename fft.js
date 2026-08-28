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

  // Sample rates are integers, so fsOut/fsIn is rational and the fractional
  // sample phase of the output repeats every fsOut/gcd samples. That many
  // kernels cover every phase exactly, which turns 48 sines and 96 cosines
  // per output sample into two table lookups. Ratios that would need an
  // absurd table (a rate that is not a plain integer, say) keep computing
  // the kernel per sample.
  function gcd(a, b) { while (b) { const t = a % b; a = b; b = t; } return a; }
  const MAX_PHASES = 8192;

  // s and w stay in separate tables so the product is formed in the same
  // order as sampleAt's `x[j] * s * w`; that keeps this bit-for-bit equal to
  // the straight evaluation rather than merely very close to it.
  function makeKernels(phases, halfTaps, fc) {
    const taps = 2 * halfTaps + 1;
    const s = new Float64Array(phases * taps);
    const w = new Float64Array(phases * taps);
    for (let p = 0; p < phases; p++) {
      const frac = p / phases;
      const first = frac > 0 ? 1 : 0;               // sampleAt's ceil(t) - floor(t)
      for (let m = first; m < taps; m++) {
        const d = frac + halfTaps - m;              // t - j for j = floor(t) - halfTaps + m
        const c = Math.PI * d / halfTaps;
        s[p * taps + m] = d === 0 ? 2 * fc : Math.sin(TWO_PI * fc * d) / (Math.PI * d);
        w[p * taps + m] = 0.42 + 0.5 * Math.cos(c) + 0.08 * Math.cos(2 * c);
      }
    }
    return { s, w, taps };
  }

  // High-quality arbitrary-ratio resampler that keeps its state between
  // calls. Unlike linear interpolation it holds the passband flat (well
  // under 0.1 % ripple below 0.4 fs) and puts aliasing images below about
  // -60 dB, which is what validating an OFDM claim at 200 ppm of clock
  // offset requires.
  //
  // Feed it a stream with process(); it returns only the output samples
  // whose whole kernel has arrived and keeps the rest of the tail for the
  // next call, so a stream cut into chunks resamples bit-for-bit the same
  // as the whole stream at once. flush() ends the stream and returns what
  // the truncated kernel makes of the last few samples.
  class Resampler {
    constructor(fsIn, fsOut, halfTaps) {
      this.fsIn = fsIn;
      this.fsOut = fsOut;
      this.halfTaps = halfTaps || 24;
      this.ratio = fsOut / fsIn;
      this.fc = 0.46 * Math.min(1, this.ratio);
      // Whole sample rates give a repeating phase and a kernel table; a rate
      // that is not a whole number (the clock-offset channel model uses one)
      // falls back to computing each kernel, positioned exactly as
      // sincResample always positioned it.
      const whole = Number.isInteger(fsIn) && Number.isInteger(fsOut) && fsIn > 0 && fsOut > 0;
      const g = whole ? gcd(fsIn, fsOut) : 0;
      this.phases = whole ? fsOut / g : 0;          // t grows by step/phases per output
      this.step = whole ? fsIn / g : 0;
      this.k = whole && this.phases <= MAX_PHASES ? makeKernels(this.phases, this.halfTaps, this.fc) : null;
      this.buf = new Float32Array(1 << 13);
      this.base = 0;                                // global index of buf[0]
      this.len = 0;                                 // live samples in buf
      this.inTotal = 0;                             // input samples ever fed
      this.outIndex = 0;                            // output samples ever emitted
      this.q = 0;                                   // floor(t) for the next output
      this.p = 0;                                   // its phase, t = q + p/phases
    }

    // Where output sample k sits in the input stream. With whole rates the
    // phase is an exact small integer that cannot drift over a long capture;
    // without them, k / ratio, which is what sincResample always used.
    _floorAt(k) { return this.k || this.phases ? this.q : Math.floor(k / this.ratio); }

    process(chunk) { this._append(chunk); return this._emit(false); }

    // The end of a finite signal: emit the samples whose kernel runs off the
    // end, exactly as sincResample's clamped `hi` does.
    flush() { return this._emit(true); }

    _append(chunk) {
      if (this.len + chunk.length > this.buf.length) {
        let n = this.buf.length;
        while (n < this.len + chunk.length) n *= 2;
        const b = new Float32Array(n);
        b.set(this.buf.subarray(0, this.len));
        this.buf = b;
      }
      this.buf.set(chunk, this.len);
      this.len += chunk.length;
      this.inTotal += chunk.length;
    }

    _emit(end) {
      const h = this.halfTaps, phases = this.phases, step = this.step, ratio = this.ratio, fc = this.fc;
      const table = this.k, exact = phases > 0;
      const nMax = Math.floor(this.inTotal * this.ratio);
      const buf = this.buf, base = this.base;
      const hiAvail = this.inTotal - 1;
      // Count first, so the output is one allocation of the right size.
      let n = 0, q = this.q, p = this.p;
      while (this.outIndex + n < nMax) {
        if (!exact) q = Math.floor((this.outIndex + n) / ratio);
        if (!end && q + h > hiAvail) break;
        n++;
        if (exact) { p += step; if (p >= phases) { q += Math.floor(p / phases); p %= phases; } }
      }
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const k = this.outIndex;
        let t;
        if (exact) { q = this.q; p = this.p; t = q + p / phases; }
        else { t = k / ratio; q = Math.floor(t); p = t - q; }
        const lo = Math.max(base, Math.max(0, p > 0 ? q + 1 - h : q - h));
        const hi = Math.min(hiAvail, q + h);
        let acc = 0;
        if (table) {
          const off = p * table.taps, first = q - h;
          for (let j = lo; j <= hi; j++) { const m = j - first; acc += buf[j - base] * table.s[off + m] * table.w[off + m]; }
        } else {
          for (let j = lo; j <= hi; j++) {
            const d = t - j;
            const sc = d === 0 ? 2 * fc : Math.sin(TWO_PI * fc * d) / (Math.PI * d);
            const c = Math.PI * d / h;
            acc += buf[j - base] * sc * (0.42 + 0.5 * Math.cos(c) + 0.08 * Math.cos(2 * c));
          }
        }
        out[i] = acc;
        this.outIndex++;
        if (exact) { this.p += step; if (this.p >= phases) { this.q += Math.floor(this.p / phases); this.p %= phases; } }
        else this.q = Math.floor(this.outIndex / ratio);
      }
      this._compact();
      return out;
    }

    // Drop everything the next output's kernel can no longer reach.
    _compact() {
      const keepFrom = Math.max(0, this.q - this.halfTaps);
      const drop = Math.min(this.len, keepFrom - this.base);
      if (drop > 0) {
        this.buf.copyWithin(0, drop, this.len);
        this.len -= drop;
        this.base += drop;
      }
    }
  }

  // The whole signal at once. Same arithmetic as a Resampler fed the whole
  // signal and flushed.
  function sincResample(x, fsIn, fsOut, halfTaps) {
    const r = new Resampler(fsIn, fsOut, halfTaps);
    r._append(x);
    return r._emit(true);
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

  const FFT = { makeFFT, makeIFFT, sincResample, Resampler, fracDelay, sampleAt };
  root.FFT = FFT;
  if (typeof module !== 'undefined' && module.exports) module.exports = FFT;
})(typeof globalThis !== 'undefined' ? globalThis : this);
