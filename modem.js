// modem.js -- bytes, codes and protocol. No DOM, no samples.
//
// Exposes one global, `Modem`, and module.exports for Node tests.
// Everything here works on Uint8Array of bytes or of 0/1 bits.

(function (root) {
  'use strict';

  // ---------------------------------------------------------------- CRC

  // CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection.
  // crc16("123456789") === 0x29B1
  function crc16(bytes, start, end) {
    if (start === undefined) start = 0;
    if (end === undefined) end = bytes.length;
    let crc = 0xFFFF;
    for (let i = start; i < end; i++) {
      crc ^= bytes[i] << 8;
      for (let b = 0; b < 8; b++) {
        crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
      }
    }
    return crc;
  }

  // CRC-32 (IEEE 802.3, reflected, as used by zip/png).
  // crc32("123456789") === 0xCBF43926
  const CRC32_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    CRC32_TABLE[n] = c >>> 0;
  }
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC32_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // --------------------------------------------------------- Hamming(8,4)

  // Hamming(7,4) in the classic layout (positions 1..7, parity at 1, 2, 4)
  // plus an overall parity bit, so single errors are corrected and double
  // errors are detected (SECDED). One data nibble becomes one code byte.
  //
  // Code byte, MSB first: pos1 pos2 pos3 pos4 pos5 pos6 pos7 p0
  //   pos1 = p1 = a^b^d      pos3 = a (data MSB)
  //   pos2 = p2 = a^c^d      pos5 = b
  //   pos4 = p3 = b^c^d      pos6 = c
  //                          pos7 = d (data LSB)
  //   p0 = parity of pos1..pos7

  function hamEncodeNibble(n) {
    const a = (n >> 3) & 1, b = (n >> 2) & 1, c = (n >> 1) & 1, d = n & 1;
    const pos = [a ^ b ^ d, a ^ c ^ d, a, b ^ c ^ d, b, c, d];
    let p0 = 0, byte = 0;
    for (let i = 0; i < 7; i++) { p0 ^= pos[i]; byte |= pos[i] << (7 - i); }
    return byte | p0;
  }

  // Returns {nibble, status}: status 0 = clean, 1 = one bit corrected,
  // 2 = two errors detected, nibble is a best guess and must not be trusted.
  function hamDecodeByte(byte) {
    const bits = new Uint8Array(8);
    for (let i = 0; i < 8; i++) bits[i] = (byte >> (7 - i)) & 1;
    let syndrome = 0, parity = 0;
    for (let i = 0; i < 7; i++) if (bits[i]) syndrome ^= (i + 1);
    for (let i = 0; i < 8; i++) parity ^= bits[i];
    let status;
    if (syndrome === 0 && parity === 0) status = 0;
    else if (syndrome !== 0 && parity === 1) { bits[syndrome - 1] ^= 1; status = 1; }
    else if (syndrome === 0 && parity === 1) status = 1;      // only p0 flipped
    else status = 2;                                          // even count of errors, not 0
    const nibble = (bits[2] << 3) | (bits[4] << 2) | (bits[5] << 1) | bits[6];
    return { nibble: nibble, status: status };
  }

  const HAM_ENC = new Uint8Array(16);
  const HAM_DEC_NIBBLE = new Uint8Array(256);
  const HAM_DEC_STATUS = new Uint8Array(256);
  for (let n = 0; n < 16; n++) HAM_ENC[n] = hamEncodeNibble(n);
  for (let b = 0; b < 256; b++) {
    const r = hamDecodeByte(b);
    HAM_DEC_NIBBLE[b] = r.nibble;
    HAM_DEC_STATUS[b] = r.status;
  }

  // n bytes in, 2n bytes out. High nibble first.
  function hammingEncode(bytes) {
    const out = new Uint8Array(bytes.length * 2);
    for (let i = 0; i < bytes.length; i++) {
      out[2 * i] = HAM_ENC[bytes[i] >> 4];
      out[2 * i + 1] = HAM_ENC[bytes[i] & 0x0F];
    }
    return out;
  }

  // 2n bytes in. Returns {bytes, corrected, uncorrectable} where the two
  // counts are numbers of code bytes, not bits.
  function hammingDecode(coded) {
    const n = coded.length >> 1;
    const out = new Uint8Array(n);
    let corrected = 0, uncorrectable = 0;
    for (let i = 0; i < n; i++) {
      const hi = coded[2 * i], lo = coded[2 * i + 1];
      out[i] = (HAM_DEC_NIBBLE[hi] << 4) | HAM_DEC_NIBBLE[lo];
      const s1 = HAM_DEC_STATUS[hi], s2 = HAM_DEC_STATUS[lo];
      if (s1 === 1) corrected++; else if (s1 === 2) uncorrectable++;
      if (s2 === 1) corrected++; else if (s2 === 2) uncorrectable++;
    }
    return { bytes: out, corrected: corrected, uncorrectable: uncorrectable };
  }

  // ---------------------------------------------------------------- bits

  function bytesToBits(bytes) {
    const bits = new Uint8Array(bytes.length * 8);
    for (let i = 0; i < bytes.length; i++) {
      for (let b = 0; b < 8; b++) bits[i * 8 + b] = (bytes[i] >> (7 - b)) & 1;
    }
    return bits;
  }

  function bitsToBytes(bits) {
    const bytes = new Uint8Array(bits.length >> 3);
    for (let i = 0; i < bytes.length; i++) {
      let v = 0;
      for (let b = 0; b < 8; b++) v = (v << 1) | (bits[i * 8 + b] & 1);
      bytes[i] = v;
    }
    return bytes;
  }

  // Block interleaver. Input is `rows` codewords of `cols` bits, written
  // row by row. Output is read column by column, so a burst of up to
  // `rows` consecutive bit errors on the air hits each codeword at most once.
  function interleave(bits, rows, cols) {
    const out = new Uint8Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) out[c * rows + r] = bits[r * cols + c];
    }
    return out;
  }

  function deinterleave(bits, rows, cols) {
    const out = new Uint8Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) out[r * cols + c] = bits[c * rows + r];
    }
    return out;
  }

  // ------------------------------------------------------------- presets

  // Every tone is a whole number of cycles per symbol and the tone spacing
  // is a multiple of the baud rate, so a one-symbol correlator at one tone
  // sees nothing of the other (non-coherent orthogonal FSK).
  const PRESETS = {
    robust: { name: 'robust', baud: 300,  spaceHz: 1500, markHz: 2100, gapSec: 0.150 },
    fast:   { name: 'fast',   baud: 1200, spaceHz: 2400, markHz: 3600, gapSec: 0.100 },
  };
  for (const k in PRESETS) {
    const p = PRESETS[k];
    if (p.markHz % p.baud !== 0 || p.spaceHz % p.baud !== 0 || (p.markHz - p.spaceHz) % p.baud !== 0) {
      throw new Error('preset ' + k + ' is not orthogonal');
    }
  }

  const PREAMBLE_SYMBOLS = 32;                 // 0101...01
  const SYNC_WORD = 0x1ACFFC1D;                 // CCSDS attached sync marker
  const SYNC_BITS = new Uint8Array(32);
  for (let i = 0; i < 32; i++) SYNC_BITS[i] = (SYNC_WORD >>> (31 - i)) & 1;
  const PREAMBLE_BITS = new Uint8Array(PREAMBLE_SYMBOLS);
  for (let i = 0; i < PREAMBLE_SYMBOLS; i++) PREAMBLE_BITS[i] = i & 1;

  // ------------------------------------------------------------- framing

  // Raw frame: type(1) | seq(2 BE) | len(1) | data(32) | crc16(2) = 38 bytes.
  // type = kind << 4 | session. After Hamming: 76 bytes = 608 bits, then
  // interleaved 76 rows x 8 cols.
  const FRAME = { DATA: 32, RAW: 38, CODED: 76, BITS: 608, ROWS: 76, COLS: 8 };
  const KIND = { START: 0, DATA: 1 };

  function buildFrame(f) {
    const raw = new Uint8Array(FRAME.RAW);
    raw[0] = ((f.kind & 0x0F) << 4) | (f.session & 0x0F);
    raw[1] = (f.seq >> 8) & 0xFF;
    raw[2] = f.seq & 0xFF;
    raw[3] = f.len & 0xFF;
    const payload = f.payload || new Uint8Array(0);
    raw.set(payload.subarray(0, FRAME.DATA), 4);
    const crc = crc16(raw, 0, 4 + FRAME.DATA);
    raw[36] = crc >> 8;
    raw[37] = crc & 0xFF;
    return raw;
  }

  function parseFrame(raw) {
    const crc = crc16(raw, 0, 4 + FRAME.DATA);
    return {
      kind: raw[0] >> 4,
      session: raw[0] & 0x0F,
      seq: (raw[1] << 8) | raw[2],
      len: raw[3],
      payload: raw.slice(4, 4 + FRAME.DATA),
      crcOk: crc === ((raw[36] << 8) | raw[37]),
    };
  }

  // Per-pass scrambling. Errors from room echo depend on the symbol pattern,
  // so the same frame would fail on every pass of the carousel. Each pass
  // XORs the air bits with a different fixed pseudo-random sequence; the
  // receiver simply tries them all and keeps the one whose CRC passes.
  // Scrambler 0 is all zeros, so pass 0 is the plain format.
  const SCRAMBLERS = 4;
  const SCRAMBLE = [];
  for (let k = 0; k < SCRAMBLERS; k++) {
    const pn = new Uint8Array(FRAME.BITS);
    let x = 0x9E3779B9 ^ (k * 0x85EBCA6B);
    for (let i = 0; i < FRAME.BITS && k > 0; i++) {
      x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
      pn[i] = (x >>> 16) & 1;
    }
    SCRAMBLE.push(pn);
  }

  function frameToBits(raw, pass) {
    const bits = interleave(bytesToBits(hammingEncode(raw)), FRAME.ROWS, FRAME.COLS);
    const pn = SCRAMBLE[((pass || 0) % SCRAMBLERS + SCRAMBLERS) % SCRAMBLERS];
    for (let i = 0; i < bits.length; i++) bits[i] ^= pn[i];
    return bits;
  }

  // Tries every scrambler; returns the first whose CRC passes, else the
  // plain (scrambler 0) decode so the caller still sees the error counts.
  function bitsToFrame(bits) {
    let first = null;
    const tmp = new Uint8Array(bits.length);
    for (let k = 0; k < SCRAMBLERS; k++) {
      const pn = SCRAMBLE[k];
      for (let i = 0; i < bits.length; i++) tmp[i] = bits[i] ^ pn[i];
      const r = hammingDecode(bitsToBytes(deinterleave(tmp, FRAME.ROWS, FRAME.COLS)));
      const out = { raw: r.bytes, corrected: r.corrected, uncorrectable: r.uncorrectable, scrambler: k };
      if (parseFrame(r.bytes).crcOk) return out;
      if (k === 0) first = out;
    }
    return first;
  }

  // START payload: size(4) | crc32(4) | totalFrames(2) | nameLen(1) | name.
  const NAME_MAX = FRAME.DATA - 11;

  function utf8(str) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(str);
    return new Uint8Array(Buffer.from(str, 'utf8'));
  }
  function fromUtf8(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder().decode(bytes);
    return Buffer.from(bytes).toString('utf8');
  }

  // Truncates the name to NAME_MAX bytes on a character boundary.
  function encodeName(name) {
    let out = new Uint8Array(0);
    for (const ch of name) {
      const next = utf8(ch);
      if (out.length + next.length > NAME_MAX) break;
      const merged = new Uint8Array(out.length + next.length);
      merged.set(out); merged.set(next, out.length);
      out = merged;
    }
    return out;
  }

  function buildStart(meta) {
    const p = new Uint8Array(FRAME.DATA);
    const v = new DataView(p.buffer);
    v.setUint32(0, meta.size >>> 0);
    v.setUint32(4, meta.crc32 >>> 0);
    v.setUint16(8, meta.totalFrames);
    const name = encodeName(meta.name || '');
    p[10] = name.length;
    p.set(name, 11);
    return p;
  }

  function parseStart(payload) {
    const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const nameLen = Math.min(payload[10], NAME_MAX);
    return {
      size: v.getUint32(0),
      crc32: v.getUint32(4),
      totalFrames: v.getUint16(8),
      name: fromUtf8(payload.subarray(11, 11 + nameLen)),
    };
  }

  // -------------------------------------------------------------- sender

  const START_EVERY = 16;   // data frames between repeated START frames

  // Turns a file into the list of raw frames for one pass. A pass is:
  // START, D0..D15, START, D16..D31, ..., START. The trailing START lets a
  // receiver that missed the first one finish a small file in one pass.
  class Sender {
    constructor(fileBytes, name, opts) {
      opts = opts || {};
      this.bytes = fileBytes;
      this.session = (opts.session !== undefined) ? (opts.session & 0x0F) : (Math.floor(Math.random() * 16));
      const totalFrames = Math.ceil(fileBytes.length / FRAME.DATA);
      if (totalFrames > 0xFFFF) throw new Error('file too big: max ' + (0xFFFF * FRAME.DATA) + ' bytes');
      this.meta = { size: fileBytes.length, crc32: crc32(fileBytes), totalFrames: totalFrames, name: name || 'file' };
      this.startFrame = buildFrame({ kind: KIND.START, session: this.session, seq: 0, len: FRAME.DATA, payload: buildStart(this.meta) });
      this.dataFrames = [];
      for (let i = 0; i < totalFrames; i++) {
        const chunk = fileBytes.subarray(i * FRAME.DATA, (i + 1) * FRAME.DATA);
        this.dataFrames.push(buildFrame({ kind: KIND.DATA, session: this.session, seq: i, len: chunk.length, payload: chunk }));
      }
    }

    passSequence() {
      const seq = [];
      for (let i = 0; i < this.dataFrames.length; i++) {
        if (i % START_EVERY === 0) seq.push(this.startFrame);
        seq.push(this.dataFrames[i]);
      }
      seq.push(this.startFrame);
      return seq;
    }
  }

  // ------------------------------------------------------------ receiver

  // Collects frames until every data frame of the current session is present
  // and the file CRC-32 matches. Data frames that arrive before their START
  // are kept under their session id so nothing is thrown away.
  class Receiver {
    constructor() { this.reset(); }

    reset() {
      this.meta = null;
      this.session = null;
      this.frames = new Map();      // seq -> Uint8Array(len), current session
      this.pending = new Map();     // session -> Map(seq -> Uint8Array)
      this.stats = { start: 0, data: 0, dup: 0, replaced: 0, buffered: 0, crcFail: 0, bad: 0 };
      this.complete = false;
      this.lastAssembled = null;
    }

    // Returns {kind, seq, session} where kind is one of
    // 'start' | 'data' | 'dup' | 'replaced' | 'buffered' | 'crcfail' | 'bad'.
    accept(raw) {
      const f = parseFrame(raw);
      if (!f.crcOk) { this.stats.crcFail++; return { kind: 'crcfail' }; }

      if (f.kind === KIND.START) {
        const meta = parseStart(f.payload);
        if (this.session === f.session && this.meta) {
          this.stats.start++;
          return { kind: 'start', dup: true, session: f.session, meta: meta };
        }
        // New session: park the old one, pick up anything buffered for the new one.
        if (this.session !== null) this.pending.set(this.session, this.frames);
        this.session = f.session;
        this.meta = meta;
        this.frames = this.pending.get(f.session) || new Map();
        this.pending.delete(f.session);
        for (const seq of Array.from(this.frames.keys())) if (seq >= meta.totalFrames) this.frames.delete(seq);
        this.complete = false;
        this.stats.start++;
        this.checkComplete();
        return { kind: 'start', dup: false, session: f.session, meta: meta };
      }

      if (f.kind !== KIND.DATA || f.len > FRAME.DATA) { this.stats.bad++; return { kind: 'bad' }; }
      const chunk = f.payload.slice(0, f.len);

      if (this.meta === null || f.session !== this.session) {
        let m = this.pending.get(f.session);
        if (!m) { m = new Map(); this.pending.set(f.session, m); }
        m.set(f.seq, chunk);
        this.stats.buffered++;
        return { kind: 'buffered', seq: f.seq, session: f.session };
      }

      if (f.seq >= this.meta.totalFrames) { this.stats.bad++; return { kind: 'bad', seq: f.seq }; }

      const have = this.frames.get(f.seq);
      if (have) {
        if (sameBytes(have, chunk)) { this.stats.dup++; return { kind: 'dup', seq: f.seq, session: f.session }; }
        // Same seq, different bytes: one of them slipped past CRC-16.
        // Keep the newer one and let CRC-32 arbitrate.
        this.frames.set(f.seq, chunk);
        this.stats.replaced++;
        this.complete = false;
        this.checkComplete();
        return { kind: 'replaced', seq: f.seq, session: f.session };
      }
      this.frames.set(f.seq, chunk);
      this.stats.data++;
      this.checkComplete();
      return { kind: 'data', seq: f.seq, session: f.session };
    }

    have() {
      const n = this.meta ? this.meta.totalFrames : 0;
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = this.frames.has(i);
      return out;
    }

    missing() {
      if (!this.meta) return Infinity;
      let m = 0;
      for (let i = 0; i < this.meta.totalFrames; i++) if (!this.frames.has(i)) m++;
      return m;
    }

    isComplete() { return this.complete; }

    checkComplete() {
      if (!this.meta || this.missing() > 0) return false;
      const r = this.assemble();
      this.complete = r.crcOk;
      return this.complete;
    }

    // Concatenates what we have. crcOk tells whether it matches the START's CRC-32.
    assemble() {
      if (!this.meta) return { bytes: new Uint8Array(0), crcOk: false, name: '' };
      const out = new Uint8Array(this.meta.size);
      let off = 0;
      for (let i = 0; i < this.meta.totalFrames; i++) {
        const c = this.frames.get(i);
        if (!c) { off += FRAME.DATA; continue; }
        out.set(c.subarray(0, Math.min(c.length, out.length - off)), off);
        off += c.length;
      }
      const ok = out.length === this.meta.size && crc32(out) === this.meta.crc32;
      this.lastAssembled = { bytes: out, crcOk: ok, name: this.meta.name };
      return this.lastAssembled;
    }
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  // --------------------------------------------------------------- export

  const Modem = {
    crc16, crc32,
    hammingEncode, hammingDecode, HAM_ENC,
    bytesToBits, bitsToBytes, interleave, deinterleave,
    PRESETS, PREAMBLE_SYMBOLS, PREAMBLE_BITS, SYNC_WORD, SYNC_BITS,
    FRAME, KIND, START_EVERY, NAME_MAX, SCRAMBLERS, SCRAMBLE,
    buildFrame, parseFrame, frameToBits, bitsToFrame, buildStart, parseStart,
    Sender, Receiver,
  };

  root.Modem = Modem;
  if (typeof module !== 'undefined' && module.exports) module.exports = Modem;
})(typeof globalThis !== 'undefined' ? globalThis : this);
