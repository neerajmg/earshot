// dsp.js -- samples in, bits out, and back. No DOM.
//
// Exposes one global, `DSP`. Needs modem.js loaded first (or required).
// All rates are in Hz and seconds; the sample rate is a parameter, never
// an assumption, so a 44.1 kHz sender and a 48 kHz receiver agree.

(function (root) {
  'use strict';

  const Modem = root.Modem || (typeof require !== 'undefined' ? require('./modem.js') : null);
  if (!Modem) throw new Error('dsp.js needs modem.js');

  const TWO_PI = 2 * Math.PI;
  const PRE = Modem.PREAMBLE_SYMBOLS;          // 32
  const SYNC_LEN = Modem.SYNC_BITS.length;      // 32
  const TEMPLATE_LEN = PRE + SYNC_LEN;          // 64
  const PAYLOAD_BITS = Modem.FRAME.BITS;        // 608
  const SYMBOLS_PER_FRAME = TEMPLATE_LEN + PAYLOAD_BITS;

  // +1 for mark, -1 for space, over preamble + sync.
  const TEMPLATE = new Float32Array(TEMPLATE_LEN);
  for (let i = 0; i < PRE; i++) TEMPLATE[i] = Modem.PREAMBLE_BITS[i] ? 1 : -1;
  for (let i = 0; i < SYNC_LEN; i++) TEMPLATE[PRE + i] = Modem.SYNC_BITS[i] ? 1 : -1;

  // Tunables. See README "Tuning".
  const CORR_THRESHOLD = 0.5;      // normalised template correlation to declare a sync
  const MAX_SYNC_ERRORS = 4;       // sync bits allowed wrong out of 32
  const NOISE_BLOCK_SEC = 0.02;
  const NOISE_HISTORY_SEC = 0.5;
  const ENV_PER_SYMBOL = 8;        // envelope points per symbol during search
  const MIN_COVERAGE = 0.75;       // fraction of template symbols that must carry signal
  const MIN_COVERAGE_LEVEL = 0.25; // "carry signal" = |d| at least this fraction of the window's max |d|
  const DFE_TAPS = 2;              // previous symbols the per-frame equaliser looks back at
  const CONFIRM_SYMBOLS = 3;       // wait this long past a peak before trusting it (template sidelobe at +-2 symbols is 0.53)

  // ---------------------------------------------------------- modulator

  function frameSymbols(bits) {
    if (bits.length !== PAYLOAD_BITS) throw new Error('need ' + PAYLOAD_BITS + ' bits');
    const out = new Uint8Array(SYMBOLS_PER_FRAME);
    out.set(Modem.PREAMBLE_BITS, 0);
    out.set(Modem.SYNC_BITS, PRE);
    out.set(bits, TEMPLATE_LEN);
    return out;
  }

  // Continuous-phase 2-FSK. Symbol k covers samples [round(k*sps), round((k+1)*sps)).
  // A raised-cosine ramp softens the first and last rampSec so the speaker
  // does not click, and gapSec of silence follows so room echo can die down.
  function modulateSymbols(symbols, preset, fs, opts) {
    opts = opts || {};
    const amp = opts.amplitude === undefined ? 0.5 : opts.amplitude;
    const rampSec = opts.rampSec === undefined ? 0.005 : opts.rampSec;
    const gapSec = opts.gap === false ? 0 : (opts.gapSec === undefined ? preset.gapSec : opts.gapSec);
    const sps = fs / preset.baud;
    const nTone = Math.round(symbols.length * sps);
    const out = new Float32Array(nTone + Math.round(gapSec * fs));
    const dMark = TWO_PI * preset.markHz / fs, dSpace = TWO_PI * preset.spaceHz / fs;
    let phase = 0;
    for (let k = 0; k < symbols.length; k++) {
      const dphi = symbols[k] ? dMark : dSpace;
      const end = Math.round((k + 1) * sps);
      for (let n = Math.round(k * sps); n < end; n++) {
        phase += dphi;
        if (phase >= TWO_PI) phase -= TWO_PI;
        out[n] = amp * Math.sin(phase);
      }
    }
    const nr = Math.min(Math.round(rampSec * fs), nTone >> 1);
    for (let i = 0; i < nr; i++) {
      const w = 0.5 - 0.5 * Math.cos(Math.PI * i / nr);
      out[i] *= w;
      out[nTone - 1 - i] *= w;
    }
    return out;
  }

  function modulateFrame(bits, preset, fs, opts) {
    return modulateSymbols(frameSymbols(bits), preset, fs, opts);
  }

  function frameDuration(preset) {
    return SYMBOLS_PER_FRAME / preset.baud + preset.gapSec;
  }

  // -------------------------------------------------------- demodulator

  function pow2ceil(n) { let p = 1; while (p < n) p <<= 1; return p; }

  // Decision feedback, fitted per frame on the 64 known symbols:
  //   d[k] = a*s[k] + b1*s[k-1] + b2*s[k-2] + ... + c     (s = +1 mark, -1 space)
  // The b's capture how much of the previous symbols still rings in the room
  // during this one. The alternating preamble alone cannot separate a from
  // b1 (s[k] is always -s[k-1] there); the sync word can. Returns null when
  // feedback does not beat the plain threshold on the training symbols.
  function fitDfe(td, bias) {
    const T = DFE_TAPS, m = T + 2;                  // unknowns: a, b1..bT, c
    const A = []; for (let i = 0; i < m; i++) A.push(new Float64Array(m + 1));
    for (let k = T; k < TEMPLATE_LEN; k++) {
      const row = [TEMPLATE[k]];
      for (let t = 1; t <= T; t++) row.push(TEMPLATE[k - t]);
      row.push(1);
      for (let i = 0; i < m; i++) { for (let j = 0; j < m; j++) A[i][j] += row[i] * row[j]; A[i][m] += row[i] * td[k]; }
    }
    // Gaussian elimination with partial pivoting.
    for (let col = 0; col < m; col++) {
      let piv = col;
      for (let r = col + 1; r < m; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
      if (Math.abs(A[piv][col]) < 1e-9) return null;
      if (piv !== col) { const t = A[piv]; A[piv] = A[col]; A[col] = t; }
      for (let r = 0; r < m; r++) {
        if (r === col) continue;
        const f = A[r][col] / A[col][col];
        for (let j = col; j <= m; j++) A[r][j] -= f * A[col][j];
      }
    }
    const a = A[0][m] / A[0][0];
    const b = [];
    for (let t = 1; t <= T; t++) b.push(A[t][m] / A[t][t]);
    const c = A[m - 1][m] / A[m - 1][m - 1];
    let bsum = 0; for (const v of b) bsum += Math.abs(v);
    if (!(a > 0) || bsum > 0.6 * a) return null;
    let plain = 0, fed = 0;
    for (let k = T; k < TEMPLATE_LEN; k++) {
      const want = TEMPLATE[k] > 0;
      let thr = c; for (let t = 1; t <= T; t++) thr += b[t - 1] * TEMPLATE[k - t];
      if ((td[k] > bias) !== want) plain++;
      if ((td[k] > thr) !== want) fed++;
    }
    if (fed > plain) return null;
    return { a: a, b: b, c: c, trainErrorsPlain: plain, trainErrorsDfe: fed };
  }

  // The noise floor is the quietest block in recent history, so that history
  // has to be longer than a frame. If it is not, then part way through a
  // transmission every block in memory is loud, the "noise" estimate climbs
  // to the signal level, and the decision variable is divided down to nothing.
  // Frames are 672 symbols, so a frame plus its gap is the unit that matters.
  function noiseHistoryFor(preset) {
    return Math.max(NOISE_HISTORY_SEC, 2 * (SYMBOLS_PER_FRAME / preset.baud + preset.gapSec));
  }

  // Streaming non-coherent 2-FSK demodulator.
  //
  //   const demod = new DSP.Demodulator(preset, fs, { onSync, onFrame });
  //   demod.push(Float32Array)   // any chunk size, any number of times
  //
  // onFrame(info) gets info.bits (608 payload bits) and must return true if
  // the frame checked out. On false the search resumes right after the sync
  // word, because a real frame may have started during a false alarm.
  //
  // How it works, in order:
  //  1. Two one-symbol quadrature correlators (mark, space) give energies
  //     Em, Es every D samples. d = (Em-Es)/(Em+Es+2*noise) is in [-1,1],
  //     ~0 in silence, and does not care about volume.
  //  2. A normalised correlation of d against the 64-symbol preamble+sync
  //     template peaks once per frame, at the end of the sync word.
  //  3. At that point the preamble gives the slicing threshold (bias),
  //     the sync word is re-sliced as a check, then the 608 payload symbols
  //     are sliced at exact sample positions derived from the sync end.
  class Demodulator {
    constructor(preset, fs, callbacks, opts) {
      this.preset = preset;
      this.fs = fs;
      this.cb = callbacks || {};
      opts = opts || {};
      this.sps = fs / preset.baud;
      this.W = Math.round(this.sps);
      this.D = Math.max(1, Math.floor(this.sps / ENV_PER_SYMBOL));
      this.symPts = this.sps / this.D;

      const W = this.W;
      this.cm = new Float32Array(W); this.sm = new Float32Array(W);
      this.cs = new Float32Array(W); this.ss = new Float32Array(W);
      for (let i = 0; i < W; i++) {
        this.cm[i] = Math.cos(TWO_PI * preset.markHz * i / fs);
        this.sm[i] = Math.sin(TWO_PI * preset.markHz * i / fs);
        this.cs[i] = Math.cos(TWO_PI * preset.spaceHz * i / fs);
        this.ss[i] = Math.sin(TWO_PI * preset.spaceHz * i / fs);
      }

      const frameSamples = Math.ceil(SYMBOLS_PER_FRAME * this.sps);
      this.ringSize = pow2ceil(Math.max(65536, 4 * frameSamples));
      this.mask = this.ringSize - 1;
      this.ring = new Float32Array(this.ringSize);
      this.total = 0;

      this.envSize = pow2ceil(Math.max(4096, Math.ceil(4 * frameSamples / this.D)));
      this.envMask = this.envSize - 1;
      this.Em = new Float32Array(this.envSize);
      this.Es = new Float32Array(this.envSize);
      this.d = new Float32Array(this.envSize);
      this.nf = new Float32Array(this.envSize);     // noise floor in force at each point
      this.corrVals = new Float32Array(TEMPLATE_LEN);
      this.envCount = 0;

      this.blockLen = Math.max(1, Math.round(NOISE_BLOCK_SEC * fs / this.D));
      const historySec = opts.noiseHistorySec === undefined ? noiseHistoryFor(preset) : opts.noiseHistorySec;
      this.blockHistory = Math.max(2, Math.round(historySec / NOISE_BLOCK_SEC));
      this.noiseHistorySec = historySec;
      this.blockAcc = 0; this.blockN = 0; this.blocks = [];
      this.noise = 1e-6;

      this.state = 'search';
      this.searchJ = 0;
      this.best = null;
      this.frame = null;
      this.lastCorr = 0;
      this.stats = { syncs: 0, falseSyncs: 0, frames: 0, framesOk: 0, noise: this.noise, snrDb: null, balanceDb: null };
      this.spans = [];
    }

    push(chunk) {
      let off = 0;
      const step = this.ringSize >> 2;
      while (off < chunk.length) {
        const n = Math.min(step, chunk.length - off);
        for (let i = 0; i < n; i++) this.ring[(this.total + i) & this.mask] = chunk[off + i];
        this.total += n;
        off += n;
        this.computeEnvelopes();
        this.run();
      }
    }

    // Energies of the mark and space correlators over samples (n-W, n].
    energiesAt(n) {
      const W = this.W, ring = this.ring, mask = this.mask;
      const cm = this.cm, sm = this.sm, cs = this.cs, ss = this.ss;
      let im = 0, qm = 0, is = 0, qs = 0;
      for (let i = 0; i < W; i++) {
        const x = ring[(n - i) & mask];
        im += x * cm[i]; qm += x * sm[i];
        is += x * cs[i]; qs += x * ss[i];
      }
      return [im * im + qm * qm, is * is + qs * qs];
    }

    decisionAt(n, noise) {
      const e = this.energiesAt(n);
      return { em: e[0], es: e[1], d: (e[0] - e[1]) / (e[0] + e[1] + 2 * noise) };
    }

    computeEnvelopes() {
      const D = this.D;
      while (true) {
        const j = this.envCount, n = j * D;
        if (n > this.total - 1) break;
        const k = j & this.envMask;
        if (n < this.W - 1) { this.Em[k] = 0; this.Es[k] = 0; this.d[k] = 0; this.nf[k] = this.noise; this.envCount++; continue; }
        const e = this.energiesAt(n);
        const em = e[0], es = e[1];
        this.Em[k] = em; this.Es[k] = es;
        this.blockAcc += em + es; this.blockN++;
        if (this.blockN >= this.blockLen) {
          this.blocks.push(this.blockAcc / this.blockN);
          if (this.blocks.length > this.blockHistory) this.blocks.shift();
          this.blockAcc = 0; this.blockN = 0;
          let m = Infinity;
          for (const b of this.blocks) if (b < m) m = b;
          this.noise = Math.max(m, 1e-12);
          this.stats.noise = this.noise;
        }
        this.d[k] = (em - es) / (em + es + 2 * this.noise);
        this.nf[k] = this.noise;
        this.envCount++;
      }
    }

    // Normalised correlation of the decision stream with the template,
    // assuming the sync word ends at envelope point j.
    corrAt(j) {
      const n0 = j * this.D;
      const vals = this.corrVals;
      let num = 0, den = 0, maxAbs = 0;
      for (let k = 0; k < TEMPLATE_LEN; k++) {
        const jj = Math.round((n0 - Math.round((TEMPLATE_LEN - 1 - k) * this.sps)) / this.D);
        if (jj < 0) return 0;
        const v = this.d[jj & this.envMask];
        vals[k] = v;
        num += TEMPLATE[k] * v;
        den += v * v;
        const a = v < 0 ? -v : v;
        if (a > maxAbs) maxAbs = a;
      }
      if (den <= 0) return 0;
      // The whole template has to sit on signal. Silence scores zero in d, so
      // the tail of a frame followed by its gap could otherwise pass on a
      // few lucky symbols.
      let covered = 0;
      const floor = MIN_COVERAGE_LEVEL * maxAbs;
      for (let k = 0; k < TEMPLATE_LEN; k++) { const a = vals[k] < 0 ? -vals[k] : vals[k]; if (a >= floor) covered++; }
      if (covered < MIN_COVERAGE * TEMPLATE_LEN) return 0;
      return num / Math.sqrt(TEMPLATE_LEN * den);
    }

    run() {
      for (;;) {
        if (this.state === 'search') {
          const lastJ = this.envCount - 1;
          let synced = false;
          while (this.searchJ <= lastJ) {
            const c = this.corrAt(this.searchJ);
            this.lastCorr = c;
            if (c >= CORR_THRESHOLD && (!this.best || c > this.best.corr)) this.best = { j: this.searchJ, corr: c };
            if (this.best && this.searchJ - this.best.j >= CONFIRM_SYMBOLS * this.symPts) {
              const b = this.best;
              this.best = null;
              if (this.trySync(b)) { synced = true; this.searchJ = b.j + 1; break; }
              this.searchJ = b.j + Math.round(this.symPts);
              continue;
            }
            this.searchJ++;
          }
          if (!synced) return;
        }
        if (this.state === 'slicing') {
          if (this.total - 1 < this.frame.endSample) return;
          this.sliceFrame();
        }
      }
    }

    trySync(b) {
      const t0 = b.j * this.D;
      const noise = this.nf[b.j & this.envMask];   // as it was then, not at the head of the buffer
      const td = new Float32Array(TEMPLATE_LEN);
      let bias = 0, emMark = 0, esSpace = 0, onTone = 0;
      for (let k = 0; k < TEMPLATE_LEN; k++) {
        const n = t0 - Math.round((TEMPLATE_LEN - 1 - k) * this.sps);
        const r = this.decisionAt(n, noise);
        td[k] = r.d;
        if (k < PRE) {
          bias += r.d;
          if (Modem.PREAMBLE_BITS[k]) emMark += r.em; else esSpace += r.es;
        } else {
          onTone += Math.max(r.em, r.es);
        }
      }
      bias /= PRE;
      let errors = 0;
      for (let k = 0; k < SYNC_LEN; k++) if ((td[PRE + k] > bias ? 1 : 0) !== Modem.SYNC_BITS[k]) errors++;
      if (errors > MAX_SYNC_ERRORS) { this.stats.falseSyncs++; return false; }

      // noise is the silence mean of Em+Es = 2*sigma^2*W; a tone gives (A*W/2)^2.
      // Their ratio times 2 is the SNR in a bandwidth of one baud.
      const snrDb = 10 * Math.log10(2 * (onTone / SYNC_LEN) / noise);
      const balanceDb = 10 * Math.log10((emMark / (PRE / 2)) / Math.max(esSpace / (PRE / 2), 1e-20));
      const dfe = fitDfe(td, bias);
      this.frame = {
        t0: t0,
        startSample: t0 - Math.round(TEMPLATE_LEN * this.sps),
        endSample: t0 + Math.round(PAYLOAD_BITS * this.sps),
        bias: bias, noise: noise, corr: b.corr, syncErrors: errors,
        snrDb: snrDb, balanceDb: balanceDb, dfe: dfe,
      };
      this.state = 'slicing';
      this.stats.syncs++;
      this.stats.snrDb = snrDb;
      this.stats.balanceDb = balanceDb;
      if (this.cb.onSync) this.cb.onSync(this.frame);
      return true;
    }

    sliceFrame() {
      const f = this.frame;
      const bits = new Uint8Array(PAYLOAD_BITS);
      const dfe = f.dfe;
      const prev = [];                                   // prev[0] = last symbol, prev[1] = the one before
      for (let t = 1; t <= DFE_TAPS; t++) prev.push(TEMPLATE[TEMPLATE_LEN - t]);
      let above = 0, nAbove = 0, below = 0, nBelow = 0;
      for (let k = 0; k < PAYLOAD_BITS; k++) {
        const n = f.t0 + Math.round((k + 1) * this.sps);
        const r = this.decisionAt(n, f.noise);
        // With a DFE the threshold moves depending on what the last symbols were.
        let thr = f.bias;
        if (dfe) { thr = dfe.c; for (let t = 0; t < DFE_TAPS; t++) thr += dfe.b[t] * prev[t]; }
        let sym;
        if (r.d > thr) { bits[k] = 1; above += r.d - thr; nAbove++; sym = 1; }
        else { bits[k] = 0; below += thr - r.d; nBelow++; sym = -1; }
        for (let t = DFE_TAPS - 1; t > 0; t--) prev[t] = prev[t - 1];
        prev[0] = sym;
      }
      f.bits = bits;
      f.softMargin = Math.min(nAbove ? above / nAbove : 0, nBelow ? below / nBelow : 0);
      this.stats.frames++;
      const ok = this.cb.onFrame ? !!this.cb.onFrame(f) : true;
      if (ok) this.stats.framesOk++;
      this.spans.push({ start: f.startSample, end: f.endSample, ok: ok });
      if (this.spans.length > 64) this.spans.shift();
      this.state = 'search';
      this.best = null;
      // After a bad frame, look again from just past the sync word: a real
      // frame may have started during a false alarm. Skip the peak's own
      // shoulder so the same sync is not found twice.
      this.searchJ = ok ? Math.floor(f.endSample / this.D) + 1 : Math.floor(f.t0 / this.D) + Math.round(CONFIRM_SYMBOLS * this.symPts);
      this.frame = null;
    }

    // Time in seconds of the newest sample.
    now() { return this.total / this.fs; }
  }

  // ----------------------------------------------------------------- WAV

  // RIFF/WAVE, mono PCM16. `samples` is a Float32Array in [-1,1] or an Int16Array.
  function wavEncode(samples, fs) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const str = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, fs, true); v.setUint32(28, fs * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    str(36, 'data'); v.setUint32(40, n * 2, true);
    if (samples instanceof Int16Array) {
      for (let i = 0; i < n; i++) v.setInt16(44 + 2 * i, samples[i], true);
    } else {
      for (let i = 0; i < n; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        v.setInt16(44 + 2 * i, Math.round(s < 0 ? s * 32768 : s * 32767), true);
      }
    }
    return buf;
  }

  // Reads PCM 8/16/24/32-bit and float32 WAV, any channel count; returns channel 0.
  function wavDecode(arrayBuffer) {
    const v = new DataView(arrayBuffer);
    const tag = (off) => String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
    if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
    let off = 12, fmt = null, data = null;
    while (off + 8 <= v.byteLength) {
      const id = tag(off), size = v.getUint32(off + 4, true);
      if (id === 'fmt ') {
        fmt = { format: v.getUint16(off + 8, true), channels: v.getUint16(off + 10, true), rate: v.getUint32(off + 12, true), bits: v.getUint16(off + 22, true) };
        if (fmt.format === 0xFFFE && size >= 40) fmt.format = v.getUint16(off + 8 + 24, true);  // extensible: sub-format
      } else if (id === 'data') {
        // A recorder that was killed leaves size 0 or a placeholder; use what is there.
        const left = v.byteLength - off - 8;
        data = { off: off + 8, size: (size === 0 || size > left) ? left : size };
      }
      off += 8 + size + (size & 1);
    }
    if (!fmt || !data) throw new Error('WAV without fmt or data chunk');
    const bytes = fmt.bits >> 3, frame = bytes * fmt.channels;
    const n = Math.floor(data.size / frame);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const p = data.off + i * frame;
      if (fmt.format === 3 && fmt.bits === 32) out[i] = v.getFloat32(p, true);
      else if (fmt.bits === 16) { const s = v.getInt16(p, true); out[i] = s < 0 ? s / 32768 : s / 32767; }
      else if (fmt.bits === 8) out[i] = (v.getUint8(p) - 128) / 128;
      else if (fmt.bits === 24) out[i] = ((v.getUint8(p) | (v.getUint8(p + 1) << 8) | (v.getInt8(p + 2) << 16))) / 8388608;
      else if (fmt.bits === 32) out[i] = v.getInt32(p, true) / 2147483648;
      else throw new Error('unsupported WAV: format ' + fmt.format + ', ' + fmt.bits + ' bits');
    }
    return { fs: fmt.rate, samples: out, channels: fmt.channels, bits: fmt.bits };
  }

  // ------------------------------------------------------------ helpers

  // Power of x at frequency f. Used by tests and self-checks.
  function goertzelPower(x, fs, f) {
    const w = TWO_PI * f / fs, coeff = 2 * Math.cos(w);
    let s0 = 0, s1 = 0, s2 = 0;
    for (let i = 0; i < x.length; i++) { s0 = x[i] + coeff * s1 - s2; s2 = s1; s1 = s0; }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
  }

  const DSP = {
    TEMPLATE_LEN, SYMBOLS_PER_FRAME, CORR_THRESHOLD, MAX_SYNC_ERRORS, DFE_TAPS,
    frameSymbols, modulateSymbols, modulateFrame, frameDuration,
    Demodulator, wavEncode, wavDecode, goertzelPower, noiseHistoryFor,
  };
  root.DSP = DSP;
  if (typeof module !== 'undefined' && module.exports) module.exports = DSP;
})(typeof globalThis !== 'undefined' ? globalThis : this);
