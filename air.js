// air.js -- the whole OFDM transfer chain: file in, samples out, and back.
//
// A frame on the air:
//   chirp (40 ms) | guard (10 ms) | CE symbol | 2 signalling symbols |
//   symCount data symbols | gap (15 ms)
//
// The data symbols carry one convolutional codeword. Decoded, that is 1043
// bytes: a 96-byte manifest block (so a late joiner learns the file's shape
// from any single frame) and three 266-byte droplets from the fountain
// layer. Droplets are what make one-way work: any enough-of-them rebuild
// the file, so a lost frame costs its droplets, never a pass.
//
// A passphrase hides the file's contents and its name (both live inside the
// ciphertext). The payload's size does not hide: the receiver needs it to
// size its fountain windows, so it stays in the clear in the manifest.
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
  const MAX_PUSH = 1 << 16;                          // 1.4 s: the largest chunk Receiver.push takes in one bite
  const SYM_COUNT = 72;                              // data symbols per frame
  const LANES = SYM_COUNT * Ofdm.P.data.length * 2;  // coded bits per frame
  const INFO_BITS = LANES / 2 - (Fec.K - 1);         // 8346
  const FRAME_BYTES = INFO_BITS >> 3;                // 1043
  const MANIFEST_BYTES = 96;
  const DROPLET_BYTES = 2 + 4 + Fountain.BLOCK + 4;  // 266: win, id, payload, CRC-32
  const DROPLETS_PER_FRAME = Math.floor((FRAME_BYTES - MANIFEST_BYTES) / DROPLET_BYTES);   // 3
  const NAME_BYTES = 64;                             // manifest name field
  const MAX_PAYLOAD = 2 * 1048576 + 64;              // the page's 2 MB ceiling plus crypto overhead
  const QUIET_SECONDS = 10;                          // silence after which another sender may take the room
  const PROFILE = 2;                                 // QPSK rate 1/2
  const ILV = Fec.interleaveMap(LANES);
  const F_GZIP = 1;                                  // payload is gzipped
  const F_ENCRYPTED = 2;                             // payload is AES-GCM
  const F_NAME_INSIDE = 4;                           // the name is in the payload, not the manifest
  const CHIRP = Chirp.makeChirp(FS);
  const INV_SQRT2 = Math.SQRT1_2;

  // ------------------------------------------------------------- timing
  //
  // What a frame costs, from the parts Sender.nextFrame actually lays down.
  // Every estimate anywhere - the page, the benchmark table, the tools, the
  // guide - reads these rather than re-deriving them; the hand copies had
  // already drifted 32 samples apart.

  const BODY_SAMPLES = (1 + Ofdm.P.sigSymbols + SYM_COUNT) * Ofdm.P.symbolLen + Ofdm.P.roll;
  const FRAME_SAMPLES = CHIRP.length + GUARD + BODY_SAMPLES + GAP;
  const FRAME_SEC = FRAME_SAMPLES / FS;

  // Frames for a payload of `bytes`: three droplets a frame, plus two spare
  // so a late joiner still hears the tail. This is what the sender's
  // progress bar counts to. Feed it the on-air size, not the file size -
  // see `estimate`.
  function framesFor(bytes) { return Math.ceil((Math.ceil(bytes / Fountain.BLOCK) || 1) / DROPLETS_PER_FRAME) + 2; }
  function secondsFor(bytes) { return framesFor(bytes) * FRAME_SEC; }

  // ------------------------------------------------------------ manifest

  // Names longer than the manifest's 64 bytes are trimmed, not chopped. The
  // cut lands on a character boundary, so no half codepoint arrives as
  // U+FFFD, and the extension survives because ".txt" is the part that says
  // what the file is; the base name is what gives way.
  function encodeName(name) {
    const enc = new TextEncoder();
    const s = String(name || '') || 'file';
    if (enc.encode(s).length <= NAME_BYTES) return enc.encode(s);
    const dot = s.lastIndexOf('.');
    let ext = dot > 0 ? s.slice(dot) : '';
    if (enc.encode(ext).length > 16) ext = '';       // a dot deep in a long name is not an extension
    const room = NAME_BYTES - enc.encode(ext).length;
    let base = '', used = 0;
    for (const c of ext ? s.slice(0, dot) : s) {     // a rejected extension is just more name
      const n = enc.encode(c).length;
      if (used + n > room) break;
      base += c; used += n;
    }
    return enc.encode((base + ext) || 'file');
  }

  function packManifest(m) {
    const out = new Uint8Array(MANIFEST_BYTES);
    out[0] = 0x45; out[1] = 0x62;                    // 'Eb'
    out[2] = m.flags & 0xFF;
    out[3] = (m.winCount >> 8) & 0xFF; out[4] = m.winCount & 0xFF;
    const v = new DataView(out.buffer);
    v.setUint32(5, m.size >>> 0);
    v.setUint32(9, m.crc32 >>> 0);
    // flags bit 2: the name travels inside the encrypted payload, so the
    // field on the air is empty rather than a plaintext leak.
    const name = (m.flags & F_NAME_INSIDE) ? new Uint8Array(0) : encodeName(m.name);
    out[13] = name.length;
    out.set(name, 14);
    const crc = Modem.crc16(out, 0, MANIFEST_BYTES - 2);
    out[MANIFEST_BYTES - 2] = crc >> 8;
    out[MANIFEST_BYTES - 1] = crc & 0xFF;
    return out;
  }

  // The windows a payload of this size is cut into. Fountain.makeWindows is
  // the only splitter, so this is the only winCount a manifest may claim.
  function windowsFor(size) {
    const blocks = Math.ceil(size / Fountain.BLOCK) || 1;
    return Math.ceil(blocks / Fountain.WINDOW) || 1;
  }

  // Magic and CRC-16 only: these bytes claim to be a manifest.
  function readManifest(bytes) {
    if (bytes[0] !== 0x45 || bytes[1] !== 0x62) return null;      // 'Eb'
    const crc = Modem.crc16(bytes, 0, MANIFEST_BYTES - 2);
    if (crc !== ((bytes[MANIFEST_BYTES - 2] << 8) | bytes[MANIFEST_BYTES - 1])) return null;
    const v = new DataView(bytes.buffer, bytes.byteOffset);
    const nameLen = bytes[13];
    return {
      flags: bytes[2],
      winCount: (bytes[3] << 8) | bytes[4],
      size: v.getUint32(5),
      crc32: v.getUint32(9),
      nameLen,
      name: new TextDecoder().decode(bytes.subarray(14, 14 + Math.min(nameLen, NAME_BYTES))),
    };
  }

  // 16 bits of CRC let about one corrupt manifest in 65536 through, and a
  // manifest sizes every window the receiver builds, so the fields have to
  // agree with each other before any of them is believed. An inconsistent
  // one used to reach fountain.js as a negative block count and throw.
  function manifestOk(m) {
    if (!m) return false;
    if (m.flags & ~7) return false;                               // bits 0..2 are all this version speaks
    if (m.size > MAX_PAYLOAD) return false;
    if (m.nameLen > NAME_BYTES) return false;
    if ((m.flags & F_NAME_INSIDE) && m.nameLen !== 0) return false;   // name is inside the payload, not here
    return m.winCount === windowsFor(m.size);
  }

  function parseManifest(bytes) {
    const m = readManifest(bytes);
    return manifestOk(m) ? m : null;
  }

  const sameManifest = (a, b) => a.crc32 === b.crc32 && a.size === b.size &&
    a.winCount === b.winCount && a.flags === b.flags && a.name === b.name;

  // ---------------------------------------------------------- compression

  async function gzip(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // The send side simply skips compression when CompressionStream is missing
  // (see squeeze). The receive side cannot skip anything - the bytes on the
  // air are already gzipped - so it has to say what is wrong instead.
  async function gunzip(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('this browser cannot unpack the compressed file (Safari needs 16.4 or newer; Chrome, Edge and Firefox are fine). Receive it again in a newer browser.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // gzip, but only when it earns its keep. `prepare` and the page's pre-send
  // estimate both come through here, so what the estimate promises is what
  // actually plays.
  async function squeeze(bytes) {
    try {
      const z = await gzip(bytes);
      if (z.length < bytes.length * 0.95) return { bytes: z, gzipped: true };
    } catch (e) { /* no CompressionStream here: send raw */ }
    return { bytes, gzipped: false };
  }

  // ---------------------------------------- the name inside the payload

  // With a passphrase the file name is part of the secret, so it travels
  // inside the ciphertext: [nameLen:1][name utf-8][file bytes], wrapped
  // before compression. Same 64-byte limit and the same character-boundary
  // trim as the manifest, so the two paths cannot disagree.
  function wrapName(name, bytes) {
    const n = encodeName(name);
    const out = new Uint8Array(1 + n.length + bytes.length);
    out[0] = n.length;
    out.set(n, 1);
    out.set(bytes, 1 + n.length);
    return out;
  }

  function unwrapName(bytes) {
    const n = bytes.length ? bytes[0] : 0;
    if (bytes.length < 1 + n) return { name: '', bytes: new Uint8Array(0) };
    return { name: new TextDecoder().decode(bytes.subarray(1, 1 + n)), bytes: bytes.subarray(1 + n) };
  }

  // ---------------------------------------------------------- encryption

  // Optional passphrase: AES-256-GCM with a PBKDF2-derived key. Sound is a
  // broadcast - anyone in earshot with this same public page decodes the
  // transfer - so the docs say that plainly and this is the fix. Compression
  // happens first (ciphertext does not compress); salt and IV travel in
  // front of the ciphertext; GCM's tag upgrades integrity from CRC-against-
  // noise to proof-against-tampering.
  //
  // 600,000 iterations is the OWASP figure for PBKDF2-SHA-256. The channel is
  // recordable and a recording keeps forever, so the threat is offline
  // guessing, and the cost is paid once per transfer. Measured (Apple M5,
  // headless Chrome 151): 37.5 ms at 600,000 against 13.4 ms at 210,000, and
  // 53.7 ms against 20.9 ms in Node. A phone five to ten times slower pays
  // about a fifth of a second, once, on a transfer that runs for minutes.
  const PBKDF2_ITERS = 600000;

  // crypto.subtle exists only in a secure context. A file:// copy or a plain
  // http:// page has none, and the raw TypeError that follows tells a user
  // nothing they can act on.
  function webcrypto() {
    const c = typeof crypto !== 'undefined' ? crypto : null;
    if (!c || !c.subtle) {
      throw new Error('this page cannot encrypt or decrypt here: the browser only offers crypto over https. Open the published https:// page rather than a local copy.');
    }
    return c;
  }

  async function deriveKey(passphrase, salt) {
    const raw = await webcrypto().subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
      raw, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }

  async function encrypt(bytes, passphrase) {
    const salt = webcrypto().getRandomValues(new Uint8Array(16));
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
      throw new Error('wrong passphrase — check it and try again; passphrases are case-sensitive.');
    }
  }

  // -------------------------------------------------------------- sender

  // Prepares a file: compresses if that helps, cuts into fountain windows.
  // A passphrase is used exactly as given - never trimmed, because trimming
  // silently changes the secret. One that is only whitespace is refused: it
  // cannot be told to anyone and it is nearly always an accident.
  async function prepare(bytes, name, opts) {
    const pass = passOf(opts);
    let flags = 0;
    // With a passphrase the name is part of what is hidden, so it goes into
    // the payload before compression and the manifest carries none.
    if (pass !== null) { bytes = wrapName(name, bytes); flags |= F_NAME_INSIDE; }
    const z = await squeeze(bytes);
    let payload = z.bytes;
    if (z.gzipped) flags |= F_GZIP;
    if (pass !== null) {
      payload = await encrypt(payload, pass);
      flags |= F_ENCRYPTED;
    }
    const windows = Fountain.makeWindows(payload);
    return {
      name, flags, payload,
      windows,
      manifest: packManifest({ flags, winCount: windows.length, size: payload.length, crc32: Modem.crc32(payload), name: (flags & F_NAME_INSIDE) ? '' : name }),
    };
  }

  // The one reading of `opts.passphrase`: absent is not the same as empty,
  // and whitespace alone is refused rather than silently sent in the clear.
  function passOf(opts) {
    const p = opts && opts.passphrase !== undefined && opts.passphrase !== null ? String(opts.passphrase) : null;
    if (p !== null && p.trim() === '') {
      throw new Error('a passphrase of only spaces cannot be used; leave it out to send without one');
    }
    return p;
  }

  // What the transfer will really cost, before the user commits to it. The
  // page used to quote the raw file size and so promised three times the
  // airtime a text file needs, because compression only happened inside
  // `prepare`. gzip is cheap enough to run on the pick - tens of
  // milliseconds at the 2 MB ceiling - so the quote can just be true. It
  // walks the same path prepare does, name wrapper included, so the size it
  // reports is the size that plays.
  const CRYPTO_BYTES = 16 + 12 + 16;                 // salt, nonce, GCM tag
  async function estimate(bytes, opts) {
    const pass = passOf(opts);
    const src = pass !== null ? wrapName(opts && opts.name, bytes) : bytes;
    const z = await squeeze(src);
    const size = z.bytes.length + (pass !== null ? CRYPTO_BYTES : 0);
    return { bytes: size, gzipped: z.gzipped, frames: framesFor(size), seconds: secondsFor(size) };
  }

  class Sender {
    constructor(prep, opts) {
      this.prep = prep;
      this.session = (opts && opts.session !== undefined) ? opts.session & 0xFF : (Math.random() * 256) | 0;
      this.nextId = prep.windows.map(() => 0);
      this.amplitude = (opts && opts.amplitude) || 0.8;
      this.papr = !opts || opts.papr !== false;
    }

    // The window furthest behind, measured as droplets sent per block it
    // holds. Straight round-robin gave a trailing window of one block as
    // much air as a full one of 256, so a file a byte over 64 kB cost twice
    // the airtime the page promised. Ties go to the lowest window, which
    // keeps equal windows in index order, exactly as before.
    _pickWindow() {
      const ws = this.prep.windows;
      let best = 0;
      for (let i = 1; i < ws.length; i++) {
        // nextId[i]/count[i] < nextId[best]/count[best], done in integers
        if (this.nextId[i] * ws[best].count < this.nextId[best] * ws[i].count) best = i;
      }
      return best;
    }

    // The next frame's bytes: manifest + three droplets, from whichever
    // windows have had the least so far.
    frameBytes() {
      const out = new Uint8Array(FRAME_BYTES);
      out.set(this.prep.manifest, 0);
      for (let d = 0; d < DROPLETS_PER_FRAME; d++) {
        const w = this._pickWindow();
        const id = this.nextId[w]++;
        const off = MANIFEST_BYTES + d * DROPLET_BYTES;
        out[off] = (w >> 8) & 0xFF; out[off + 1] = w & 0xFF;
        const v = new DataView(out.buffer);
        v.setUint32(off + 2, id >>> 0);
        out.set(Fountain.makeDroplet(this.prep.windows[w].blocks, w, id), off + 6);
        // CRC-32, not CRC-16: a droplet that passes a bad check is not
        // dropped noise, it is a wrong row welded into a window's algebra
        // that no later droplet can lift out.
        v.setUint32(off + 6 + Fountain.BLOCK, Modem.crc32(out.subarray(off, off + 6 + Fountain.BLOCK)));
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
      const out = new Float32Array(FRAME_SAMPLES);
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
      this.buf = new Float32Array(1 << 22);          // ~87 s ring at 48 k, 64 x the biggest push
      this.mask = this.buf.length - 1;
      this.total = 0;
      this.pending = [];                             // chirp detections awaiting samples
      this.det = new Chirp.Detector(this.fs, { onDetect: (d) => this.pending.push(d) });
      this.decoders = new Map();                     // window -> WindowDecoder
      this.manifest = null;
      this.rival = null;                             // a different manifest, waiting for a second sighting
      this.session = null;                           // latched from the first manifest we believed
      this.lastHeard = 0;                            // this.total when that session was last heard
      this.quiet = QUIET_SECONDS * this.fs;          // when that counts as gone
      this.result = null;
      this.stats = { frames: 0, framesOk: 0, droplets: 0, dropletCrcFail: 0, sigFail: 0, manifestBad: 0, otherSession: 0, fileCrcFail: 0 };
    }

    // A push has to be small enough that _drain sees a frame before the ring
    // wraps past it: the page and the tools feed 4096 samples at a time, but
    // handing over a whole recording in one call is a reasonable thing to do
    // and used to overwrite the oldest audio in silence. Anything larger than
    // MAX_PUSH is fed through in MAX_PUSH-sample pieces, which is what a
    // caller pushing incrementally would have got.
    push(chunk) {
      if (chunk.length > MAX_PUSH) {
        for (let o = 0; o < chunk.length; o += MAX_PUSH) this.push(chunk.subarray(o, Math.min(chunk.length, o + MAX_PUSH)));
        return;
      }
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

      // Two senders in one room used to swap the manifest on alternate
      // frames and finish neither. The session byte says which is which:
      // once one is adopted, the other is not heard until ours has finished
      // or has been silent long enough to be gone. The page's reset also
      // clears the latch, by building a new Receiver.
      if (this.session !== null && sig.session !== this.session) {
        if (!this.result && this.total - this.lastHeard < this.quiet) { this.stats.otherSession++; return; }
        this.session = null;
        this.rival = null;
      }
      this.lastHeard = this.total;

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

      const raw = readManifest(bytes.subarray(0, MANIFEST_BYTES));
      const man = manifestOk(raw) ? raw : null;
      if (raw && !man) this.stats.manifestBad++;
      let any = false;
      if (man) {
        any = true;
        if (!this.manifest) this._adopt(man, sig.session);
        else if (!sameManifest(this.manifest, man)) {
          // Adopting a manifest throws away every window in progress, so a
          // rival has to be heard twice before it costs us the transfer.
          if (this.rival && sameManifest(this.rival, man)) this._adopt(man, sig.session);
          else this.rival = man;
        } else this.rival = null;
      }
      // Still a rival after all that: this frame's droplets are pieces of a
      // file we are not collecting, and XOR-ing them into our windows would
      // poison them.
      const foreign = !!(man && this.manifest && !sameManifest(this.manifest, man));
      for (let d = 0; !foreign && d < DROPLETS_PER_FRAME; d++) {
        const off = MANIFEST_BYTES + d * DROPLET_BYTES;
        const v = new DataView(bytes.buffer, bytes.byteOffset);
        const crc = Modem.crc32(bytes.subarray(off, off + 6 + Fountain.BLOCK));
        if (crc !== v.getUint32(off + 6 + Fountain.BLOCK)) { this.stats.dropletCrcFail++; continue; }
        const w = (bytes[off] << 8) | bytes[off + 1];
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
          if (!(count > 0 && count <= Fountain.WINDOW)) continue;   // a bad count is an Invalid array length
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

    // Take this manifest as the shape of the transfer, and this sender as
    // the one we are listening to. A different file means everything
    // collected so far is about the wrong bytes; the same file again (our
    // sender coming back after a gap) costs nothing.
    _adopt(man, session) {
      if (!this.manifest || !sameManifest(this.manifest, man)) {
        this.decoders.clear();
        this.result = null;
      }
      this.manifest = man;
      this.rival = null;
      this.session = session;
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
      if (Modem.crc32(out) !== this.manifest.crc32) {
        // Every window is full and the file is still wrong: a droplet that
        // passed its CRC and lied, or a manifest that did. Keeping this as
        // "the result" would end the transfer on a lie and stop the
        // microphone, and nothing but a reload would recover. Drop the
        // windows, say so, keep listening: the sender is still going.
        this.stats.fileCrcFail++;
        this.decoders.clear();
        this.rival = null;
        if (this.cb.onFailed) this.cb.onFailed({ manifest: this.manifest, stats: this.stats, attempts: this.stats.fileCrcFail, recovering: true });
        return;
      }
      this.result = { payload: out, crcOk: true, manifest: this.manifest };
      if (this.cb.onComplete) this.cb.onComplete(this.result);
    }

    // True when the completed transfer needs a passphrase to open.
    needsPassphrase() { return !!(this.result && (this.result.manifest.flags & F_ENCRYPTED)); }

    // True when even the file's name is inside the ciphertext, so there is
    // nothing honest to call the transfer until it is unlocked.
    nameHidden() { return !!(this.manifest && (this.manifest.flags & F_NAME_INSIDE)); }

    // Final bytes: decrypted if the sender encrypted (throws on a wrong
    // passphrase - GCM authenticates), decompressed if compressed. Async.
    async file(opts) {
      if (!this.result || !this.result.crcOk) return null;
      let bytes = this.result.payload;
      const flags = this.result.manifest.flags;
      if (flags & F_ENCRYPTED) {
        if (!opts || !opts.passphrase) { const e = new Error('passphrase required — type the one the sender used.'); e.needsPassphrase = true; throw e; }
        bytes = await decrypt(bytes, opts.passphrase);
      }
      if (flags & F_GZIP) bytes = await gunzip(bytes);
      // flags bit 2: the sender hid the name inside the payload.
      if (flags & F_NAME_INSIDE) return unwrapName(bytes);
      return { name: this.result.manifest.name, bytes };
    }
  }

  const Air = {
    FS, SYM_COUNT, FRAME_BYTES, FRAME_SAMPLES, FRAME_SEC, MANIFEST_BYTES, DROPLET_BYTES, DROPLETS_PER_FRAME,
    NAME_BYTES, MAX_PAYLOAD, GUARD, GAP, PROFILE, F_GZIP, F_ENCRYPTED, F_NAME_INSIDE,
    framesFor, secondsFor, estimate, prepare, Sender, Receiver,
    packManifest, parseManifest, readManifest, manifestOk, encodeName, wrapName, unwrapName,
    gzip, gunzip, squeeze, encrypt, decrypt,
  };
  root.Air = Air;
  if (typeof module !== 'undefined' && module.exports) module.exports = Air;
})(typeof globalThis !== 'undefined' ? globalThis : this);
