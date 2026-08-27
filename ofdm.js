// ofdm.js -- the OFDM physical layer. New engine beside dsp.js, shares none
// of its code: dsp.js is binary-FSK to the bone.
//
// Numbers (from the design review): N = 1024 at a forced 48 kHz, so
// subcarriers sit 46.875 Hz apart; bins 32..159 span 1500-7500 Hz. Of the
// 128: 116 carry data, 8 are continual pilots, 4 stay silent so the noise
// floor is measurable per symbol with no history games. Cyclic prefix 256
// samples (a 128 profile can come later), 32-sample raised-cosine tails
// overlap-added so the spectrum does not click. A Zadoff-Chu symbol leads
// each frame for channel estimation.
//
// Exposes one global, `Ofdm`. Requires fft.js.

(function (root) {
  'use strict';

  const FFT = root.FFT || (typeof require !== 'undefined' ? require('./fft.js') : null);
  if (!FFT) throw new Error('ofdm.js needs fft.js');
  const Fec = root.Fec || (typeof require !== 'undefined' ? require('./fec.js') : null);
  const Modem = root.Modem || (typeof require !== 'undefined' ? require('./modem.js') : null);

  const TWO_PI = 2 * Math.PI;

  const P = {
    fs: 48000,
    N: 1024,
    cp: 256,
    roll: 32,                    // raised-cosine tail, overlap-added
    binLo: 32,                   // 1500 Hz
    binHi: 159,                  // 7453 Hz
    paprDb: 8,
    paprIters: 2,
  };
  P.symbolLen = P.N + P.cp;                          // 1280 -> 37.5 symbols/s
  P.bins = [];
  for (let b = P.binLo; b <= P.binHi; b++) P.bins.push(b);
  P.pilots = [38, 54, 70, 86, 102, 118, 134, 150];
  P.nulls = [45, 77, 109, 141];
  P.data = P.bins.filter((b) => !P.pilots.includes(b) && !P.nulls.includes(b));   // 116 bins

  // Pilot values: fixed pseudo-random QPSK so the pilot line is not a tone.
  const PILOT_VAL = P.pilots.map((b, i) => {
    const ph = (TWO_PI * ((i * 7 + 3) % 8)) / 8;
    return [Math.cos(ph), Math.sin(ph)];
  });

  // Zadoff-Chu across the 128 used bins: constant amplitude in frequency,
  // low PAPR in time, ideal for one-shot channel estimation.
  const ZC = P.bins.map((b, n) => {
    const ph = -Math.PI * 25 * n * n / P.bins.length;
    return [Math.cos(ph), Math.sin(ph)];
  });

  const fft = FFT.makeFFT(P.N);
  const ifft = FFT.makeIFFT(P.N);

  // ---------------------------------------------------------------- TX

  // One OFDM symbol from a frequency-domain map: values[b] = [re, im] for
  // each occupied bin. Returns N+cp+roll samples; the last `roll` samples
  // are a tail meant to overlap-add into the next symbol's head.
  function synthesize(values, opts) {
    const papr = !opts || opts.papr !== false;
    const re = new Float64Array(P.N), im = new Float64Array(P.N);
    for (const [b, v] of values) {
      re[b] = v[0]; im[b] = v[1];
      re[P.N - b] = v[0]; im[P.N - b] = -v[1];       // hermitian: real output
    }
    ifft(re, im);
    // PAPR shaping: clip against the target, then re-confine to the band.
    // It buys back ~3.5 dB of radiated power on a peak-limited speaker and
    // costs an in-band distortion floor around -23 dB - which is why the
    // linearity gate below measures with it off.
    for (let it = 0; it < (papr ? P.paprIters : 0); it++) {
      let pow = 0;
      for (let i = 0; i < P.N; i++) pow += re[i] * re[i];
      const rms = Math.sqrt(pow / P.N);
      const limit = rms * Math.pow(10, P.paprDb / 20);
      let clipped = false;
      for (let i = 0; i < P.N; i++) {
        if (re[i] > limit) { re[i] = limit; clipped = true; }
        else if (re[i] < -limit) { re[i] = -limit; clipped = true; }
      }
      if (!clipped) break;
      for (let i = 0; i < P.N; i++) im[i] = 0;
      fft(re, im);
      const keep = new Uint8Array(P.N);
      for (const [b] of values) { keep[b] = 1; keep[P.N - b] = 1; }
      for (let i = 0; i < P.N; i++) if (!keep[i]) { re[i] = 0; im[i] = 0; }
      ifft(re, im);
    }
    // assemble cp + body + rc tail
    const out = new Float64Array(P.cp + P.N + P.roll);
    for (let i = 0; i < P.cp; i++) out[i] = re[P.N - P.cp + i];
    for (let i = 0; i < P.N; i++) out[P.cp + i] = re[i];
    for (let i = 0; i < P.roll; i++) out[P.cp + P.N + i] = re[i % P.N];   // cyclic continuation
    // raised-cosine edges
    for (let i = 0; i < P.roll; i++) {
      const w = 0.5 - 0.5 * Math.cos(Math.PI * i / P.roll);
      out[i] *= w;
      out[out.length - 1 - i] *= w;
    }
    return out;
  }

  function ceValues() { return P.bins.map((b, n) => [b, ZC[n]]); }

  function dataValues(qpsk) {
    // qpsk: array of 116 [re,im]
    const vals = [];
    for (let i = 0; i < P.data.length; i++) vals.push([P.data[i], qpsk[i]]);
    for (let i = 0; i < P.pilots.length; i++) vals.push([P.pilots[i], PILOT_VAL[i]]);
    return vals;
  }

  // A frame body: CE symbol then the data symbols, overlap-added, scaled to
  // a peak of `amplitude`. `symbols` is an array of 116-entry QPSK arrays.
  function txBody(symbols, amplitude, opts) {
    const parts = [synthesize(ceValues(), opts)].concat(symbols.map((s) => synthesize(dataValues(s), opts)));
    const step = P.symbolLen;
    const total = step * parts.length + P.roll;
    const out = new Float32Array(total);
    for (let s = 0; s < parts.length; s++) {
      const off = s * step;
      for (let i = 0; i < parts[s].length; i++) out[off + i] += parts[s][i];
    }
    let peak = 1e-12;
    for (let i = 0; i < out.length; i++) peak = Math.max(peak, Math.abs(out[i]));
    const g = (amplitude === undefined ? 0.8 : amplitude) / peak;
    for (let i = 0; i < out.length; i++) out[i] *= g;
    return out;
  }

  // ---------------------------------------------------------------- RX

  // Demodulate a frame body that starts at sample `start` in x (start = the
  // first sample of the CE symbol's cyclic prefix). Returns per-symbol
  // equalized data-bin values plus channel and noise state.
  function rxBody(x, start, nSymbols) {
    const win = Math.round(0.6 * P.cp);              // FFT window offset into the CP
    const re = new Float64Array(P.N), im = new Float64Array(P.N);

    function binsAt(off) {
      for (let i = 0; i < P.N; i++) { const v = x[off + i]; re[i] = v === undefined ? 0 : v; im[i] = 0; }
      fft(re, im);
      const out = new Map();
      for (const b of P.bins) out.set(b, [re[b], im[b]]);
      return out;
    }

    // channel estimate from the CE symbol
    const ce = binsAt(start + win);
    const Hraw = new Map();
    P.bins.forEach((b, n) => {
      const y = ce.get(b), z = ZC[n];
      // H = Y / Z ; |Z| = 1 so division is multiply by conjugate
      Hraw.set(b, [y[0] * z[0] + y[1] * z[1], y[1] * z[0] - y[0] * z[1]]);
    });
    // Smooth across neighbouring bins: the channel is coherent over several
    // bins in any room the cyclic prefix can handle, and a [1,2,1] window
    // halves the estimation noise without filling in comb notches (a wider
    // window was tried and broke the notch-visibility gate) - which is what keeps the signalling
    // field decodable at the bottom of the link budget. The FFT window
    // offset imprints a known phase ramp of 2*pi*(win-cp)/N per bin
    // (measured: -35.9 deg/bin), which would wreck a naive average, so:
    // de-ramp, average, re-ramp.
    const ramp = TWO_PI * (win - P.cp) / P.N;
    const H = new Map();
    P.bins.forEach((b) => {
      let re = 0, im = 0, wsum = 0;
      for (const [db, w] of [[-1, 1], [0, 2], [1, 1]]) {
        const h = Hraw.get(b + db);
        if (!h) continue;
        const th = -ramp * db;                        // rotate neighbour onto b
        const c = Math.cos(th), sn = Math.sin(th);
        re += w * (h[0] * c - h[1] * sn);
        im += w * (h[0] * sn + h[1] * c);
        wsum += w;
      }
      H.set(b, [re / wsum, im / wsum]);
    });
    // the CE window offset (win) imprints a phase ramp on H itself; that is
    // fine - the same ramp sits on every data symbol and divides out.

    const symbols = [];
    let noisePow = 0, noiseCount = 0;
    // Slope (timing drift) and gain change slowly by physics - drift is ppm
    // of a symbol per symbol - while their per-symbol estimates from eight
    // pilots are noisy exactly when the link is weakest. The slope grows as
    // a ramp under clock offset, so it gets a g-h tracker (no steady-state
    // lag on ramps); gain gets a plain EMA; common phase stays per-symbol.
    let slopeEst = 0, slopeRate = 0, gainEma = 1;
    for (let s = 0; s < nSymbols; s++) {
      const off = start + (s + 1) * P.symbolLen + win;
      const Y = binsAt(off);

      // Pilots: common phase + gain + a timing-drift slope across bins.
      // Everything is measured against the g-h tracker's PREDICTION: under
      // clock offset the true slope grows without bound, and edge pilots
      // eventually sit more than pi away from the common phase - raw
      // residuals then wrap, the fit aliases, and the tracker collapses
      // (observed as accuracy decaying to coin-flip along the frame). The
      // innovation against a prediction stays tiny forever.
      const mid = (P.binLo + P.binHi) / 2;
      const slopePred = s === 0 ? 0 : slopeEst + slopeRate;
      let pr = 0, pi = 0;
      const pilotPh = [];
      P.pilots.forEach((b, i) => {
        const y = Y.get(b), h = H.get(b), v = PILOT_VAL[i];
        // expected = H * pilot, advanced by the predicted per-bin ramp
        const th = slopePred * (b - mid);
        const c = Math.cos(th), sn = Math.sin(th);
        const e0r = h[0] * v[0] - h[1] * v[1], e0i = h[0] * v[1] + h[1] * v[0];
        const er = e0r * c - e0i * sn, ei = e0r * sn + e0i * c;
        const rr = y[0] * er + y[1] * ei, ri = y[1] * er - y[0] * ei;
        pr += rr; pi += ri;
        pilotPh.push([b, Math.atan2(ri, rr)]);
      });
      const commonPh = Math.atan2(pi, pr);
      let num = 0, den = 0;
      for (const [b, ph] of pilotPh) {
        let d = ph - commonPh;
        while (d > Math.PI) d -= TWO_PI;
        while (d < -Math.PI) d += TWO_PI;
        num += (b - mid) * d;
        den += (b - mid) * (b - mid);
      }
      const innovation = den ? num / den : 0;        // rad/bin beyond the prediction
      if (s === 0) { slopeEst = innovation; slopeRate = 0; }
      else {
        slopeEst = slopePred + 0.4 * innovation;
        slopeRate += 0.1 * innovation;
      }
      const slope = slopeEst;

      // common gain from pilot magnitude vs channel magnitude
      let gNum = 0, gDen = 0;
      P.pilots.forEach((b, i) => {
        const y = Y.get(b), h = H.get(b);
        gNum += Math.hypot(y[0], y[1]);
        gDen += Math.hypot(h[0], h[1]);
      });
      const gainRaw = gDen > 1e-12 ? gNum / gDen : 1;
      gainEma = s === 0 ? gainRaw : 0.7 * gainEma + 0.3 * gainRaw;
      const gain = gainEma;

      // noise from the null bins
      for (const b of P.nulls) {
        const y = Y.get(b);
        noisePow += y[0] * y[0] + y[1] * y[1];
        noiseCount++;
      }

      // equalize data bins: undo channel, common phase, slope, gain
      const eq = [];
      for (const b of P.data) {
        const y = Y.get(b), h = H.get(b);
        const hh = h[0] * h[0] + h[1] * h[1];
        const ph = commonPh + slope * (b - mid);
        const c = Math.cos(ph), sn = Math.sin(ph);
        // y * e^{-j ph} * conj(h) / (|h|^2 * gain)
        const yr = y[0] * c + y[1] * sn, yi = y[1] * c - y[0] * sn;
        const zr = (yr * h[0] + yi * h[1]) / (hh * gain + 1e-20);
        const zi = (yi * h[0] - yr * h[1]) / (hh * gain + 1e-20);
        eq.push([zr, zi, hh]);                        // hh: for LLR weighting later
      }
      symbols.push({ eq, commonPh, slope, gain });
    }
    return { symbols, H, noisePow: noiseCount ? noisePow / noiseCount : 0 };
  }

  // ------------------------------------------------------- signalling

  // The first two data symbols of every frame announce what follows, so one
  // receiver handles every profile with nothing configured. They are
  // ordinary symbols to rxBody; the announcement rides as BPSK on the data
  // bins at or below bin 117 (1500-5500 Hz - chosen so a microphone that
  // cuts off near 4-5 kHz still acquires), while the higher data bins carry
  // fixed filler. 44 bits, convolutionally coded and part-repeated to fill
  // 156 lanes, CRC-16 inside.
  P.sigBins = P.data.filter((b) => b <= 117);        // 78 per symbol
  P.sigSymbols = 2;
  const SIG_LANES = P.sigBins.length * P.sigSymbols; // 156
  const SIG_INFO = 44;
  const SIG_CODED = 2 * (SIG_INFO + 6);              // 100
  const FILLER = P.data.map((b, i) => {
    const ph = TWO_PI * ((i * 5 + 1) % 8) / 8;
    return [Math.cos(ph), Math.sin(ph)];
  });

  // fields: {profile 0..15, cp 0..1, band 0..3, symCount 0..1023,
  //          session 0..255, flags 0..7}
  function sigPack(f) {
    const bits = new Uint8Array(SIG_INFO);
    let i = 0;
    const put = (v, n) => { for (let b = n - 1; b >= 0; b--) bits[i++] = (v >> b) & 1; };
    put(f.profile & 15, 4);
    put(f.cp & 1, 1);
    put(f.band & 3, 2);
    put(f.symCount & 1023, 10);
    put(f.session & 255, 8);
    put(f.flags & 7, 3);
    // crc over the 28 payload bits, packed into 4 bytes (last nibble zero)
    const bytes = new Uint8Array(4);
    for (let b = 0; b < 28; b++) if (bits[b]) bytes[b >> 3] |= 0x80 >> (b & 7);
    const crc = Modem.crc16(bytes);
    put(crc, 16);
    return bits;
  }

  function sigUnpack(bits) {
    let i = 0;
    const get = (n) => { let v = 0; for (let b = 0; b < n; b++) v = (v << 1) | bits[i++]; return v; };
    const f = { profile: get(4), cp: get(1), band: get(2), symCount: get(10), session: get(8), flags: get(3) };
    const crc = get(16);
    const bytes = new Uint8Array(4);
    for (let b = 0; b < 28; b++) if (bits[b]) bytes[b >> 3] |= 0x80 >> (b & 7);
    f.crcOk = crc === Modem.crc16(bytes);
    return f;
  }

  // Two symbol maps (116 QPSK entries each) announcing `fields`.
  function sigEncode(fields) {
    const coded = Fec.encode(sigPack(fields));        // 100 bits
    const symbols = [];
    for (let s = 0; s < P.sigSymbols; s++) {
      const sym = FILLER.map((v) => [v[0], v[1]]);    // filler everywhere first
      for (let k = 0; k < P.sigBins.length; k++) {
        const lane = s * P.sigBins.length + k;
        const bit = coded[lane % SIG_CODED];
        const di = P.data.indexOf(P.sigBins[k]);
        sym[di] = [bit ? -1 : 1, 0];                  // BPSK on the real axis
      }
      symbols.push(sym);
    }
    return symbols;
  }

  // rxSymbols: the first two entries of rxBody(...).symbols. noise: the
  // rxBody noisePow. Soft-combines the repeated lanes, Viterbi-decodes,
  // checks the CRC.
  function sigDecode(rxSymbols, noisePow) {
    const llrs = new Float64Array(SIG_CODED);
    for (let s = 0; s < P.sigSymbols; s++) {
      for (let k = 0; k < P.sigBins.length; k++) {
        const lane = s * P.sigBins.length + k;
        const di = P.data.indexOf(P.sigBins[k]);
        const [zr, , hh] = rxSymbols[s].eq[di];
        const w = hh / (noisePow + 1e-20);
        llrs[lane % SIG_CODED] += zr * Math.min(w, 1e4);
      }
    }
    return sigUnpack(Fec.decode(llrs, SIG_INFO));
  }

  const Ofdm = { P, synthesize, ceValues, dataValues, txBody, rxBody, ZC, PILOT_VAL, FILLER, sigPack, sigUnpack, sigEncode, sigDecode };
  root.Ofdm = Ofdm;
  if (typeof module !== 'undefined' && module.exports) module.exports = Ofdm;
})(typeof globalThis !== 'undefined' ? globalThis : this);
