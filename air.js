// air.js -- the whole OFDM transfer chain: file in, samples out, and back.
//
// A frame on the air:
//   chirp (40 ms) | guard (10 ms) | CE symbol | 2 signalling symbols |
//   symCount data symbols | gap (15 ms)
//
// The data symbols carry one convolutional codeword. Decoded, that is 1043
// bytes: a 96-byte manifest block (so a late joiner learns the file's shape
// from any single frame) and three 264-byte droplets from the fountain
// layer. Droplets are what make one-way work: any enough-of-them rebuild
// the file, so a lost frame costs its droplets, never a pass.
//
// Exposes one global, `Air`. Needs fft, chirp, ofdm, fec, fountain, modem.

(function (root) {
  'use strict';

  const req = (name, path) => root[name] || (typeof require !== 'undefined' ? require(path) : null);
  const FFT = req('FFT', './fft.js');
  const Chirp = req('Chirp', './chirp.js');
  const Ofdm = req('Ofdm', './ofdm.js');
  const Fec = req('Fec', './fec.js');
  const Fountain = req('Fountain', './fountain.js');
  const Modem = req('Modem', './modem.js');

  const FS = 48000;
  const GUARD = Math.round(0.010 * FS);
  const GAP = Math.round(0.015 * FS);
  const SYM_COUNT = 72;                              // data symbols per frame
  const LANES = SYM_COUNT * Ofdm.P.data.length * 2;  // coded bits per frame
  const INFO_BITS = LANES / 2 - (Fec.K - 1);         // 8346
  const FRAME_BYTES = INFO_BITS >> 3;                // 1043
  const MANIFEST_BYTES = 96;
  const DROPLET_BYTES = 2 + 4 + Fountain.BLOCK + 2;  // 264
  const DROPLETS_PER_FRAME = Math.floor((FRAME_BYTES - MANIFEST_BYTES) / DROPLET_BYTES);   // 3
  const PROFILE = 2;                                 // QPSK rate 1/2
  const ILV = Fec.interleaveMap(LANES);
  const CHIRP = Chirp.makeChirp(FS);
  const INV_SQRT2 = Math.SQRT1_2;

  // ------------------------------------------------------------ manifest

  function packManifest(m) {
    const out = new Uint8Array(MANIFEST_BYTES);
    out[0] = 0x45; out[1] = 0x61;                    // 'Ea'
    out[2] = m.flags & 0xFF;
    out[3] = (m.winCount >> 8) & 0xFF; out[4] = m.winCount & 0xFF;
    const v = new DataView(out.buffer);
    v.setUint32(5, m.size >>> 0);
    v.setUint32(9, m.crc32 >>> 0);
    const name = new TextEncoder().encode(m.name || 'file').subarray(0, 64);
    out[13] = name.length;
    out.set(name, 14);
    const crc = Modem.crc16(out, 0, MANIFEST_BYTES - 2);
    out[MANIFEST_BYTES - 2] = crc >> 8;
    out[MANIFEST_BYTES - 1] = crc & 0xFF;
    return out;
  }

  function parseManifest(bytes) {
    if (bytes[0] !== 0x45 || bytes[1] !== 0x61) return null;
    const crc = Modem.crc16(bytes, 0, MANIFEST_BYTES - 2);
    if (crc !== ((bytes[MANIFEST_BYTES - 2] << 8) | bytes[MANIFEST_BYTES - 1])) return null;
    const v = new DataView(bytes.buffer, bytes.byteOffset);
    return {
      flags: bytes[2],
      winCount: (bytes[3] << 8) | bytes[4],
      size: v.getUint32(5),
      crc32: v.getUint32(9),
      name: new TextDecoder().decode(bytes.subarray(14, 14 + Math.min(bytes[13], 64))),
    };
  }

  // ---------------------------------------------------------- compression

  async function gzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function gunzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // ---------------------------------------------------------- encryption

  // Optional passphrase: AES-256-GCM with a PBKDF2-derived key. Sound is a
  // broadcast - anyone in earshot with this same public page decodes the
  // transfer - so the docs say that plainly and this is the fix. Compression
  // happens first (ciphertext does not compress); salt and IV travel in
  // front of the ciphertext; GCM's tag upgrades integrity from CRC-against-
  // noise to proof-against-tampering.
  const PBKDF2_ITERS = 210000;

  async function deriveKey(passphrase, salt) {
    const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
      raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function encrypt(bytes, passphrase) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
    const out = new Uint8Array(28 + ct.length);
    out.set(salt, 0); out.set(iv, 16); out.set(ct, 28);
    return out;
  }

  async function decrypt(bytes, passphrase) {
    const key = await deriveKey(passphrase, bytes.subarray(0, 16));
    try {
      return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(16, 28) }, key, bytes.subarray(28)));
    } catch (e) {
      throw new Error('wrong passphrase (or a corrupted transfer that still passed CRC)');
    }
  }

  // -------------------------------------------------------------- sender

  // Prepares a file: compresses if that helps, cuts into fountain windows.
  async function prepare(bytes, name, opts) {
    let flags = 0, payload = bytes;
    try {
      const z = await gzip(bytes);
      if (z.length < bytes.length * 0.95) { payload = z; flags |= 1; }
    } catch (e) { /* no CompressionStream here: send raw */ }
    if (opts && opts.passphrase) {
      payload = await encrypt(payload, opts.passphrase);
      flags |= 2;
    }
    const windows = Fountain.makeWindows(payload);
    return {
      name, flags, payload,
      windows,
      manifest: packManifest({ flags, winCount: windows.length, size: payload.length, crc32: Modem.crc32(payload), name }),
    };
  }

  class Sender {
    constructor(prep, opts) {
      this.prep = prep;
      this.session = (opts && opts.session !== undefined) ? opts.session & 0xFF : (Math.random() * 256) | 0;
      this.nextId = prep.windows.map(() => 0);
      this.rr = 0;                                   // round-robin window cursor
      this.amplitude = (opts && opts.amplitude) || 0.8;
      this.papr = !opts || opts.papr !== false;
    }

    // The next frame's bytes: manifest + three droplets, round-robin.
    frameBytes() {
      const out = new Uint8Array(FRAME_BYTES);
      out.set(this.prep.manifest, 0);
      for (let d = 0; d < DROPLETS_PER_FRAME; d++) {
        const w = this.rr;
        this.rr = (this.rr + 1) % this.prep.windows.length;
        const id = this.nextId[w]++;
        const off = MANIFEST_BYTES + d * DROPLET_BYTES;
        out[off] = (w >> 8) & 0xFF; out[off + 1] = w & 0xFF;
        const v = new DataView(out.buffer);
        v.setUint32(off + 2, id >>> 0);
        out.set(Fountain.makeDroplet(this.prep.windows[w].blocks, w, id), off + 6);
        const crc = Modem.crc16(out, off, off + 6 + Fountain.BLOCK);
        out[off + 6 + Fountain.BLOCK] = crc >> 8;
        out[off + 7 + Fountain.BLOCK] = crc & 0xFF;
      }
      return out;
    }

    // One whole frame as samples.
    nextFrame() {
      const bytes = this.frameBytes();
      const info = new Uint8Array(INFO_BITS);
      info.set(Modem.bytesToBits(bytes).subarray(0, FRAME_BYTES * 8));
      const coded = Fec.encode(info);                // LANES bits
      const air = Fec.interleave(coded, ILV);
      const symbols = Ofdm.sigEncode({ profile: PROFILE, cp: 1, band: 0, symCount: SYM_COUNT, session: this.session, flags: 0 });
      for (let s = 0; s < SYM_COUNT; s++) {
        const sym = [];
        for (let k = 0; k < Ofdm.P.data.length; k++) {
          const i = (s * Ofdm.P.data.length + k) * 2;
          sym.push([air[i] ? -INV_SQRT2 : INV_SQRT2, air[i + 1] ? -INV_SQRT2 : INV_SQRT2]);
        }
        symbols.push(sym);
      }
      const body = Ofdm.txBody(symbols, this.amplitude, { papr: this.papr });
      const out = new Float32Array(CHIRP.length + GUARD + body.length + GAP);
      let peak = 0;
      for (const v of body) peak = Math.max(peak, Math.abs(v));
      for (let i = 0; i < CHIRP.length; i++) out[i] = CHIRP[i] * this.amplitude;
      out.set(body, CHIRP.length + GUARD);
      return out;
    }
  }

  // ------------------------------------------------------------ receiver

  class Receiver {
    constructor(fs, callbacks) {
      this.fs = fs || FS;
      this.cb = callbacks || {};
      this.buf = new Float32Array(1 << 22);          // ~87 s ring at 48 k
      this.mask = this.buf.length - 1;
      this.total = 0;
      this.pending = [];                             // chirp detections awaiting samples
      this.det = new Chirp.Detector(this.fs, { onDetect: (d) => this.pending.push(d) });
      this.decoders = new Map();                     // window -> WindowDecoder
      this.manifest = null;
      this.result = null;
      this.stats = { frames: 0, framesOk: 0, droplets: 0, dropletCrcFail: 0, sigFail: 0 };
    }

    push(chunk) {
      for (let i = 0; i < chunk.length; i++) this.buf[(this.total + i) & this.mask] = chunk[i];
      this.total += chunk.length;
      this.det.push(chunk);
      this._drain();
    }

    _read(start, len) {
      const out = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        const n = start + i;
        out[i] = n >= 0 && n < this.total && n > this.total - this.buf.length ? this.buf[n & this.mask] : 0;
      }
      return out;
    }

    _drain() {
      while (this.pending.length) {
        const d = this.pending[0];
        const bodyStart = d.tEnd + GUARD;
        const need = bodyStart + (1 + Ofdm.P.sigSymbols + SYM_COUNT) * Ofdm.P.symbolLen + Ofdm.P.roll;
        if (this.total < need) return;               // wait for the frame to arrive
        this.pending.shift();
        this._frame(bodyStart);
      }
    }

    _frame(bodyStart) {
      this.stats.frames++;
      const nSym = Ofdm.P.sigSymbols + SYM_COUNT;
      const len = (1 + nSym) * Ofdm.P.symbolLen + Ofdm.P.roll;
      const x = this._read(bodyStart, len);
      const rx = Ofdm.rxBody(x, 0, nSym);
      const sig = Ofdm.sigDecode(rx.symbols.slice(0, Ofdm.P.sigSymbols), rx.noisePow);
      if (!sig.crcOk || sig.profile !== PROFILE || sig.symCount !== SYM_COUNT) { this.stats.sigFail++; return; }

      // LLR grid from the data symbols
      const llrs = new Float64Array(LANES);
      const noise = rx.noisePow + 1e-20;
      for (let s = 0; s < SYM_COUNT; s++) {
        const sym = rx.symbols[Ofdm.P.sigSymbols + s];
        for (let k = 0; k < Ofdm.P.data.length; k++) {
          const [zr, zi, hh] = sym.eq[k];
          const w = Math.min(hh / noise, 1e4);
          const i = (s * Ofdm.P.data.length + k) * 2;
          // bit 1 was mapped to -1, so a positive axis reading argues for
          // bit 0, which is exactly the decoder's llr>0 convention
          llrs[i] = zr * w;
          llrs[i + 1] = zi * w;
        }
      }
      const info = Fec.decode(Fec.deinterleave(llrs, ILV), INFO_BITS);
      const bytes = Modem.bitsToBytes(info.subarray(0, FRAME_BYTES * 8));

      const man = parseManifest(bytes.subarray(0, MANIFEST_BYTES));
      let any = false;
      if (man) {
        if (!this.manifest || this.manifest.crc32 !== man.crc32) {
          this.manifest = man;
          this.decoders.clear();
          this.result = null;
        }
        any = true;
      }
      for (let d = 0; d < DROPLETS_PER_FRAME; d++) {
        const off = MANIFEST_BYTES + d * DROPLET_BYTES;
        const crc = Modem.crc16(bytes, off, off + 6 + Fountain.BLOCK);
        if (crc !== ((bytes[off + 6 + Fountain.BLOCK] << 8) | bytes[off + 7 + Fountain.BLOCK])) { this.stats.dropletCrcFail++; continue; }
        const w = (bytes[off] << 8) | bytes[off + 1];
        const v = new DataView(bytes.buffer, bytes.byteOffset);
        const id = v.getUint32(off + 2);
        if (this.manifest && w >= this.manifest.winCount) continue;
        let dec = this.decoders.get(w);
        if (!dec) {
          // window sizes: all full except possibly the last
          let count = Fountain.WINDOW;
          if (this.manifest) {
            const blocks = Math.ceil(this.manifest.size / Fountain.BLOCK) || 1;
            count = w === this.manifest.winCount - 1 ? blocks - Fountain.WINDOW * (this.manifest.winCount - 1) : Fountain.WINDOW;
          }
          dec = new Fountain.WindowDecoder(w, count);
          this.decoders.set(w, dec);
        }
        dec.add(id, bytes.subarray(off + 6, off + 6 + Fountain.BLOCK));
        this.stats.droplets++;
        any = true;
      }
      if (any) this.stats.framesOk++;
      if (this.cb.onFrame) this.cb.onFrame({ sig, manifest: this.manifest, stats: this.stats, progress: this.progress() });
      this._checkComplete();
    }

    progress() {
      if (!this.manifest) return 0;
      const totalBlocks = Math.ceil(this.manifest.size / Fountain.BLOCK) || 1;
      let have = 0;
      for (const dec of this.decoders.values()) have += dec.rank;
      return Math.min(1, have / totalBlocks);
    }

    _checkComplete() {
      if (this.result || !this.manifest) return;
      if (this.decoders.size < this.manifest.winCount) return;
      for (const dec of this.decoders.values()) if (!dec.isComplete()) return;
      const out = new Uint8Array(this.manifest.size);
      let off = 0;
      for (let w = 0; w < this.manifest.winCount; w++) {
        for (const b of this.decoders.get(w).solve()) {
          const take = Math.min(Fountain.BLOCK, out.length - off);
          if (take > 0) out.set(b.subarray(0, take), off);
          off += take;
        }
      }
      const crcOk = Modem.crc32(out) === this.manifest.crc32;
      this.result = { payload: out, crcOk, manifest: this.manifest };
      if (this.cb.onComplete) this.cb.onComplete(this.result);
    }

    // True when the completed transfer needs a passphrase to open.
    needsPassphrase() { return !!(this.result && (this.result.manifest.flags & 2)); }

    // Final bytes: decrypted if the sender encrypted (throws on a wrong
    // passphrase - GCM authenticates), decompressed if compressed. Async.
    async file(opts) {
      if (!this.result || !this.result.crcOk) return null;
      let bytes = this.result.payload;
      if (this.result.manifest.flags & 2) {
        if (!opts || !opts.passphrase) { const e = new Error('passphrase required'); e.needsPassphrase = true; throw e; }
        bytes = await decrypt(bytes, opts.passphrase);
      }
      if (this.result.manifest.flags & 1) bytes = await gunzip(bytes);
      return { name: this.result.manifest.name, bytes };
    }
  }

  const Air = { FS, SYM_COUNT, FRAME_BYTES, DROPLETS_PER_FRAME, GUARD, GAP, PROFILE, prepare, Sender, Receiver, packManifest, parseManifest, gzip, gunzip, encrypt, decrypt };
  root.Air = Air;
  if (typeof module !== 'undefined' && module.exports) module.exports = Air;
})(typeof globalThis !== 'undefined' ? globalThis : this);
