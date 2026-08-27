// chirp.js -- frame acquisition for the OFDM engine.
//
// A linear chirp, matched-filtered on decimated complex baseband. The point
// of a chirp over the FSK preamble it replaces: detection integrates
// coherently across 4 kHz, so a comb null that deletes 30 % of the band
// costs ~1.5 dB instead of everything. Exposes one global, `Chirp`.
//
// Timing convention: detections report the input-stream sample index of the
// chirp's END, self-calibrated at construction so the filter chain's group
// delay cancels.

(function (root) {
  'use strict';

  const TWO_PI = 2 * Math.PI;

  const DEFAULTS = {
    f0: 1500, f1: 5500, durSec: 0.040, taper: 0.10,   // Tukey taper fraction
    decim: 6,                                          // 48 kHz -> 8 kHz baseband
    firTaps: 63,
    // Normalised |MF|^2. gamma at the peak is roughly 0.79 * s/(1+s) for
    // in-band SNR s (0.79 = Hann-vs-Tukey mismatch), so a 0.30 threshold
    // would already fail at -5 dB in-band. The PSR gate is the real
    // discriminator; this floor only spares the PSR arithmetic in silence.
    threshold: 0.12,
    psrDb: 9,                                          // peak vs surrounding mean
    backScanSec: 0.008,                                // first-peak window
    firstPeakFrac: 0.5,
  };

  // The transmitted chirp: linear sweep with a Tukey window.
  function makeChirp(fs, opts) {
    const o = Object.assign({}, DEFAULTS, opts);
    const n = Math.round(o.durSec * fs);
    const out = new Float32Array(n);
    const k = (o.f1 - o.f0) / o.durSec;
    const edge = Math.max(1, Math.round(o.taper * n));
    for (let i = 0; i < n; i++) {
      const t = i / fs;
      const ph = TWO_PI * (o.f0 * t + 0.5 * k * t * t);
      let w = 1;
      if (i < edge) w = 0.5 - 0.5 * Math.cos(Math.PI * i / edge);
      else if (i >= n - edge) w = 0.5 - 0.5 * Math.cos(Math.PI * (n - 1 - i) / edge);
      out[i] = w * Math.sin(ph);
    }
    return out;
  }

  // Streaming detector.
  //   const det = new Chirp.Detector(fs, { onDetect: (d) => ... });
  //   det.push(Float32Array);          // any chunk size
  // onDetect receives { tEnd, gamma, psr } with tEnd in input samples.
  class Detector {
    constructor(fs, callbacks, opts) {
      const o = this.o = Object.assign({}, DEFAULTS, opts);
      this.fs = fs;
      this.cb = callbacks || {};
      this.fc = (o.f0 + o.f1) / 2;
      this.D = o.decim;
      this.bbFs = fs / this.D;

      // Low-pass FIR for the baseband (Blackman-windowed sinc). Cutoff just
      // above half the swept bandwidth.
      const cutHz = (o.f1 - o.f0) / 2 * 1.15;
      const T = o.firTaps, half = (T - 1) / 2;
      this.fir = new Float64Array(T);
      let sum = 0;
      for (let i = 0; i < T; i++) {
        const d = i - half;
        const s = d === 0 ? 2 * cutHz / fs : Math.sin(TWO_PI * cutHz * d / fs) / (Math.PI * d);
        const c = Math.PI * d / half;
        const w = 0.42 + 0.5 * Math.cos(c) + 0.08 * Math.cos(2 * c);
        this.fir[i] = s * w;
        sum += s * w;
      }
      for (let i = 0; i < T; i++) this.fir[i] /= sum;

      // Reference: the Hann-weighted chirp (not the Tukey TX shape - Hann
      // buys -31 dB range sidelobes) through the same mix+filter+decimate.
      const raw = makeChirp(fs, o);
      const hann = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) hann[i] = raw[i] * (0.5 - 0.5 * Math.cos(TWO_PI * i / (raw.length - 1)));
      const ref = this._basebandOffline(hann);
      this.L = ref.re.length;
      // conjugated, time-reversed reference == correlation kernel
      this.krRe = new Float64Array(this.L);
      this.krIm = new Float64Array(this.L);
      let e = 0;
      for (let i = 0; i < this.L; i++) {
        this.krRe[i] = ref.re[i];
        this.krIm[i] = -ref.im[i];
        e += ref.re[i] * ref.re[i] + ref.im[i] * ref.im[i];
      }
      this.Eref = e;

      // rings at baseband rate
      this.size = 1 << Math.ceil(Math.log2(this.L * 8 + Math.round(this.bbFs * 0.1)));
      this.mask = this.size - 1;
      this.bbRe = new Float64Array(this.size);
      this.bbIm = new Float64Array(this.size);
      this.g = new Float32Array(this.size);          // gamma history for PSR/first-peak
      this.m = 0;                                     // baseband samples produced
      this.pow = 0;                                   // sliding sum of |bb|^2 over L

      // input-side state
      this.n = 0;                                     // input samples consumed
      this.xRing = new Float64Array(1 << Math.ceil(Math.log2(o.firTaps * 4)));
      this.xMask = this.xRing.length - 1;

      // detection state
      this.best = null;                               // {m, gamma}
      this.holdUntil = -1;
      this.stats = { detections: 0, rejectedPsr: 0 };

      // Self-calibration: push the clean TX chirp through a scratch copy of
      // this very pipeline and note where the peak lands relative to the
      // known end. Applied to every reported tEnd.
      if (!opts || !opts._noCalib) {
        const probe = new Detector(fs, {}, Object.assign({}, o, { _noCalib: true, psrDb: -100, threshold: 0.05, backScanSec: 0 }));
        let found = null;
        probe.cb = { onDetect: (d) => { if (!found) found = d; } };
        const pad = new Float32Array(Math.round(0.05 * fs));
        probe.push(pad); probe.push(raw); probe.push(pad); probe.push(pad);
        const trueEnd = pad.length + raw.length;
        this.calib = found ? trueEnd - found.tEnd : 0;
      } else {
        this.calib = 0;
      }
    }

    // Offline mix -> FIR -> decimate, for building the reference.
    _basebandOffline(x) {
      const T = this.fir.length, D = this.D;
      const outN = Math.floor(x.length / D);
      const re = new Float64Array(outN), im = new Float64Array(outN);
      for (let m = 0; m < outN; m++) {
        const n0 = m * D;
        let accR = 0, accI = 0;
        for (let i = 0; i < T; i++) {
          const n = n0 - i;
          if (n < 0) break;
          const ph = TWO_PI * this.fc * n / this.fs;
          accR += x[n] * Math.cos(ph) * this.fir[i];
          accI += x[n] * -Math.sin(ph) * this.fir[i];
        }
        re[m] = accR; im[m] = accI;
      }
      return { re, im };
    }

    push(chunk) {
      const o = this.o, D = this.D, T = this.fir.length;
      for (let c = 0; c < chunk.length; c++) {
        this.xRing[this.n & this.xMask] = chunk[c];
        this.n++;
        if (this.n % D !== 0) continue;

        // one baseband sample: FIR over the last T inputs, mixed down
        let accR = 0, accI = 0;
        for (let i = 0; i < T; i++) {
          const n = this.n - 1 - i;
          if (n < 0) break;
          const v = this.xRing[n & this.xMask];
          const ph = TWO_PI * this.fc * n / this.fs;
          accR += v * Math.cos(ph) * this.fir[i];
          accI += v * -Math.sin(ph) * this.fir[i];
        }
        const mi = this.m & this.mask;
        this.bbRe[mi] = accR;
        this.bbIm[mi] = accI;

        // sliding power over the last L baseband samples
        this.pow += accR * accR + accI * accI;
        if (this.m >= this.L) {
          const old = (this.m - this.L) & this.mask;
          this.pow -= this.bbRe[old] * this.bbRe[old] + this.bbIm[old] * this.bbIm[old];
        }

        // matched filter at this position (window ends here)
        let gamma = 0;
        if (this.m >= this.L - 1 && this.pow > 1e-12) {
          let yR = 0, yI = 0;
          for (let k = 0; k < this.L; k++) {
            const idx = (this.m - this.L + 1 + k) & this.mask;
            const br = this.bbRe[idx], bi = this.bbIm[idx];
            const kr = this.krRe[k], ki = this.krIm[k];
            yR += br * kr - bi * ki;
            yI += br * ki + bi * kr;
          }
          gamma = (yR * yR + yI * yI) / (this.Eref * this.pow);
        }
        this.g[mi] = gamma;

        // candidate tracking: local max, confirmed one chirp-length later
        if (this.m > this.holdUntil && gamma >= o.threshold && (!this.best || gamma > this.best.gamma)) {
          this.best = { m: this.m, gamma };
        }
        if (this.best && this.m - this.best.m >= this.L) this._confirm();
        this.m++;
      }
    }

    _confirm() {
      const o = this.o, b = this.best;
      this.best = null;
      // PSR: peak against the mean of gamma over +-2 chirp lengths,
      // excluding the main lobe itself.
      let acc = 0, cnt = 0;
      for (let m = Math.max(0, b.m - 2 * this.L); m <= b.m + this.L - 1; m++) {
        if (Math.abs(m - b.m) < this.L >> 2) continue;
        acc += this.g[m & this.mask]; cnt++;
      }
      const floor = cnt ? acc / cnt : 1e-9;
      const psr = 10 * Math.log10(b.gamma / Math.max(floor, 1e-9));
      if (psr < o.psrDb) { this.stats.rejectedPsr++; return; }

      // first peak: earliest sample within backScan whose gamma clears half
      // the maximum - in multipath the biggest peak is often a reflection.
      const back = Math.round(o.backScanSec * this.bbFs);
      let mFirst = b.m;
      for (let m = Math.max(0, b.m - back); m < b.m; m++) {
        if (this.g[m & this.mask] >= o.firstPeakFrac * b.gamma) { mFirst = m; break; }
      }
      const tEnd = mFirst * this.D + this.calib;
      this.stats.detections++;
      this.holdUntil = mFirst + this.L;                // no re-trigger on this lobe
      if (this.cb.onDetect) this.cb.onDetect({ tEnd, gamma: b.gamma, psr });
    }
  }

  const Chirp = { makeChirp, Detector, DEFAULTS };
  root.Chirp = Chirp;
  if (typeof module !== 'undefined' && module.exports) module.exports = Chirp;
})(typeof globalThis !== 'undefined' ? globalThis : this);
