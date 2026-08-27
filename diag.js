// diag.js -- drawing. Spectrogram, decision plot, frame map, log, level meter.
//
// Exposes one global, `Diag`. Nothing here touches audio or the modem; app.js
// feeds these with samples and demodulator state and calls draw() from one
// requestAnimationFrame loop.

(function (root) {
  'use strict';

  function fit(canvas) {
    const w = canvas.clientWidth || 300;
    if (canvas.width !== w) canvas.width = w;
    return { W: canvas.width, H: canvas.height };
  }

  // ------------------------------------------------------------------ FFT

  // Radix-2, in place, real input padded with zeros in imag. N must be a power of 2.
  function makeFFT(N) {
    const cos = new Float32Array(N / 2), sin = new Float32Array(N / 2);
    for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / N); sin[i] = -Math.sin(2 * Math.PI * i / N); }
    const rev = new Uint32Array(N);
    let bits = 0; while ((1 << bits) < N) bits++;
    for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
    return function fft(re, im) {
      for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      for (let size = 2; size <= N; size <<= 1) {
        const half = size >> 1, step = N / size;
        for (let start = 0; start < N; start += size) {
          for (let k = 0; k < half; k++) {
            const wr = cos[k * step], wi = sin[k * step];
            const a = start + k, b = a + half;
            const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
            re[b] = re[a] - tr; im[b] = im[a] - ti;
            re[a] += tr; im[a] += ti;
          }
        }
      }
    };
  }

  // ---------------------------------------------------------- Spectrogram

  // Scrolling spectrogram, 0..maxHz, one column per `hop` samples. Feed it
  // raw samples with push(); it computes columns as they become due and
  // draw() flushes them. Works the same for a live mic and a decoded WAV.
  class Spectrogram {
    constructor(canvas, opts) {
      opts = opts || {};
      this.c = canvas;
      this.g = canvas.getContext('2d');
      this.N = opts.fftSize || 1024;
      this.maxHz = opts.maxHz || 5000;
      this.fft = makeFFT(this.N);
      this.win = new Float32Array(this.N);
      for (let i = 0; i < this.N; i++) this.win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / this.N);
      this.re = new Float32Array(this.N);
      this.im = new Float32Array(this.N);
      this.buf = new Float32Array(this.N);
      this.filled = 0;
      this.pending = [];
      this.tones = [];
      this.fs = 48000;
      this.hop = Math.round(this.fs / 50);
      this.sinceCol = 0;
      this.gainDb = 0;
    }

    reset(fs) {
      this.fs = fs;
      this.hop = Math.round(fs / 50);
      this.filled = 0; this.sinceCol = 0; this.pending = [];
      const { W, H } = fit(this.c);
      this.g.fillStyle = '#000'; this.g.fillRect(0, 0, W, H);
    }

    setTones(list) { this.tones = list; }

    push(chunk) {
      const N = this.N;
      for (let i = 0; i < chunk.length; i++) {
        // sliding window: keep the last N samples
        if (this.filled < N) this.buf[this.filled++] = chunk[i];
        else { this.buf.copyWithin(0, 1); this.buf[N - 1] = chunk[i]; }
        if (++this.sinceCol >= this.hop) {
          this.sinceCol = 0;
          if (this.filled === N) this.pending.push(this.column());
          if (this.pending.length > 2000) this.pending.shift();
        }
      }
    }

    column() {
      const N = this.N, re = this.re, im = this.im;
      for (let i = 0; i < N; i++) { re[i] = this.buf[i] * this.win[i]; im[i] = 0; }
      this.fft(re, im);
      const bins = N / 2;
      const out = new Float32Array(bins);
      for (let i = 0; i < bins; i++) out[i] = 10 * Math.log10(re[i] * re[i] + im[i] * im[i] + 1e-12);
      return out;
    }

    draw() {
      if (!this.pending.length) return;
      const { W, H } = fit(this.c);
      const g = this.g;
      const cols = this.pending;
      this.pending = [];
      const n = Math.min(cols.length, W);
      g.drawImage(this.c, -n, 0);
      const img = g.createImageData(n, H);
      const px = img.data;
      const binHz = (this.fs / 2) / (this.N / 2);
      const maxBin = Math.min(this.N / 2 - 1, this.maxHz / binHz);
      for (let x = 0; x < n; x++) {
        const col = cols[cols.length - n + x];
        for (let y = 0; y < H; y++) {
          const bin = Math.floor((H - 1 - y) / H * maxBin);
          // -80 dB .. +20 dB, relative to a full-scale sine through a Hann window
          const v = Math.max(0, Math.min(1, (col[bin] + 80 - this.gainDb) / 100));
          const p = (y * n + x) * 4;
          heat(v, px, p);
        }
      }
      g.putImageData(img, W - n, 0);
      for (const hz of this.tones) {
        const y = Math.round(H - 1 - hz / this.maxHz * H);
        g.fillStyle = 'rgba(255,255,255,0.35)';
        g.fillRect(W - n, y, n, 1);
      }
    }
  }

  function heat(v, px, p) {
    // black -> blue -> magenta -> yellow -> white
    let r, g, b;
    if (v < 0.25) { r = 0; g = 0; b = v * 4 * 180; }
    else if (v < 0.5) { r = (v - 0.25) * 4 * 200; g = 0; b = 180 + (v - 0.25) * 4 * 75; }
    else if (v < 0.75) { r = 200 + (v - 0.5) * 4 * 55; g = (v - 0.5) * 4 * 220; b = 255 - (v - 0.5) * 4 * 255; }
    else { r = 255; g = 220 + (v - 0.75) * 4 * 35; b = (v - 0.75) * 4 * 255; }
    px[p] = r; px[p + 1] = g; px[p + 2] = b; px[p + 3] = 255;
  }

  // -------------------------------------------------------- Decision plot

  // Plots the demodulator's decision variable d over the last `seconds`,
  // the slicing threshold of the current or last frame, and frame spans.
  class DecisionPlot {
    constructor(canvas, seconds) { this.c = canvas; this.g = canvas.getContext('2d'); this.seconds = seconds || 3; this.demod = null; }
    setDemod(demod) { this.demod = demod; }
    draw() {
      const { W, H } = fit(this.c);
      const g = this.g;
      g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
      const dm = this.demod;
      if (!dm) return;
      const D = dm.D, fs = dm.fs;
      const span = Math.round(this.seconds * fs / D);
      const last = dm.envCount - 1;
      const first = Math.max(0, last - span + 1, dm.envCount - dm.envSize);
      const mid = H / 2;
      const xOf = (sample) => W - 1 - (last - sample / D) / span * W;
      // frame spans
      for (const s of dm.spans) {
        const x0 = xOf(s.start), x1 = xOf(s.end);
        if (x1 < 0) continue;
        g.fillStyle = s.ok ? 'rgba(60,200,60,0.18)' : 'rgba(220,60,60,0.25)';
        g.fillRect(Math.max(0, x0), 0, Math.min(W, x1) - Math.max(0, x0), H);
      }
      if (dm.frame) {
        const x0 = xOf(dm.frame.startSample);
        g.fillStyle = 'rgba(80,160,255,0.15)';
        g.fillRect(Math.max(0, x0), 0, W - Math.max(0, x0), H);
      }
      // zero line and the bias line
      g.strokeStyle = '#333'; g.beginPath(); g.moveTo(0, mid); g.lineTo(W, mid); g.stroke();
      const bias = dm.frame ? dm.frame.bias : (dm.lastBias !== undefined ? dm.lastBias : null);
      if (bias !== null) {
        const y = mid - bias * (H / 2 - 2);
        g.strokeStyle = '#a80'; g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke();
      }
      // d, min/max per pixel column
      g.strokeStyle = '#4cf';
      g.beginPath();
      const perPx = span / W;
      for (let x = 0; x < W; x++) {
        const j0 = Math.floor(first + (x / W) * span), j1 = Math.floor(first + ((x + 1) / W) * span);
        if (j1 <= first || j0 > last) continue;
        let lo = 1, hi = -1;
        for (let j = Math.max(j0, first); j < Math.min(j1 + 1, last + 1); j++) {
          const v = dm.d[j & dm.envMask];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (lo > hi) continue;
        g.moveTo(x, mid - hi * (H / 2 - 2));
        g.lineTo(x, mid - lo * (H / 2 - 2) + (perPx < 1 ? 1 : 0));
      }
      g.stroke();
      g.fillStyle = '#888'; g.font = '11px sans-serif';
      g.fillText('d = (mark - space) / (mark + space + noise)   last ' + this.seconds + ' s', 6, 12);
    }
  }

  // ------------------------------------------------------------ Frame map

  class FrameMap {
    constructor(canvas) { this.c = canvas; this.g = canvas.getContext('2d'); this.have = []; this.total = 0; }
    update(have) { this.have = have; this.total = have.length; }
    draw() {
      const { W, H } = fit(this.c);
      const g = this.g;
      g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
      const n = this.total;
      if (!n) { g.fillStyle = '#555'; g.font = '11px sans-serif'; g.fillText('frame map: waiting for START', 6, 14); return; }
      let size = 14;
      while (size > 1) {
        const cols = Math.floor(W / (size + 1));
        if (Math.ceil(n / cols) * (size + 1) <= H) break;
        size--;
      }
      const cols = Math.max(1, Math.floor(W / (size + 1)));
      for (let i = 0; i < n; i++) {
        const x = (i % cols) * (size + 1), y = Math.floor(i / cols) * (size + 1);
        g.fillStyle = this.have[i] ? '#3c3' : '#333';
        g.fillRect(x, y, size, size);
      }
    }
  }

  // ------------------------------------------------------------------ Log

  class Log {
    constructor(el, max) { this.el = el; this.max = max || 400; }
    add(text, cls) {
      const atBottom = this.el.scrollTop + this.el.clientHeight >= this.el.scrollHeight - 4;
      const d = document.createElement('div');
      d.textContent = text;
      if (cls) d.className = cls;
      this.el.appendChild(d);
      while (this.el.childNodes.length > this.max) this.el.removeChild(this.el.firstChild);
      if (atBottom) this.el.scrollTop = this.el.scrollHeight;
    }
    clear() { this.el.textContent = ''; }
  }

  // ---------------------------------------------------------- Level meter

  class LevelMeter {
    constructor(canvas) { this.c = canvas; this.g = canvas.getContext('2d'); this.rms = 0; this.peak = 0; this.clipped = false; this.hold = 0; }
    push(chunk) {
      let s = 0, p = 0;
      for (let i = 0; i < chunk.length; i++) { const v = chunk[i]; s += v * v; const a = v < 0 ? -v : v; if (a > p) p = a; }
      this.rms = Math.sqrt(s / chunk.length);
      this.peak = p;
      if (p > 0.99) { this.clipped = true; this.hold = 60; }
      else if (this.hold > 0 && --this.hold === 0) this.clipped = false;
    }
    draw() {
      const { W, H } = fit(this.c);
      const g = this.g;
      g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
      const db = (v) => Math.max(0, Math.min(1, (20 * Math.log10(v + 1e-6) + 60) / 60));
      g.fillStyle = '#3a3'; g.fillRect(0, 0, W * db(this.rms), H);
      g.fillStyle = this.clipped ? '#e33' : '#8c8'; g.fillRect(W * db(this.peak) - 2, 0, 2, H);
      g.fillStyle = '#888'; g.font = '10px sans-serif';
      g.fillText((20 * Math.log10(this.rms + 1e-6)).toFixed(0) + ' dBFS rms' + (this.clipped ? '   CLIP' : ''), 4, H - 3);
    }
  }

  // Runs all drawers at up to `fps`.
  function loop(drawers, fps) {
    const interval = 1000 / (fps || 30);
    let last = 0;
    function tick(t) {
      if (t - last >= interval) { last = t; for (const d of drawers) d.draw(); }
      requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  root.Diag = { Spectrogram, DecisionPlot, FrameMap, Log, LevelMeter, loop, makeFFT };
})(typeof globalThis !== 'undefined' ? globalThis : this);
