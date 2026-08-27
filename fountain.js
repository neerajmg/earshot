// fountain.js -- the rateless layer: systematic windowed random linear
// coding over GF(2).
//
// Files are cut into 256-byte blocks, blocks into windows of up to 256.
// Droplet ids below the window's block count are the blocks themselves
// (systematic - a clean channel pays no fountain tax). Higher ids are the
// XOR of a pseudo-random half of the window, the subset derived bit-exactly
// from (window, id), so sender and receiver never exchange coefficients.
// The receiver Gaussian-eliminates per window; any `count` independent
// droplets reconstruct it, which is what deletes the carousel's
// one-missing-frame-costs-a-pass problem.
//
// The PRNG discipline is locked by golden vectors committed beside the
// first version of this file: a one-bit drift here is a silent total
// failure, so the spec is the test.
//
// Exposes one global, `Fountain`.

(function (root) {
  'use strict';

  const BLOCK = 256;                 // bytes
  const WINDOW = 256;                // blocks -> 64 kB per window
  const WORDS = BLOCK / 4;

  function mix(window, id) {
    let s = (0x9E3779B9 ^ Math.imul(window, 0x85EBCA6B) ^ Math.imul(id, 0xC2B2AE35)) >>> 0;
    if (s === 0) s = 1;
    return s;
  }

  // NOT xorshift. Coefficient words must not come from a GF(2)-linear
  // generator: every xorshift step is a linear map over GF(2), so rows
  // built from its outputs are linear functions of the 32-bit seed and a
  // whole window's rank caps at 32. The integer multiplies below are
  // non-linear over GF(2), which is the property that matters here.
  function fmix(v) {
    v ^= v >>> 16; v = Math.imul(v, 0x85EBCA6B);
    v ^= v >>> 13; v = Math.imul(v, 0xC2B2AE35);
    v ^= v >>> 16;
    return v >>> 0;
  }

  // Coefficient row for a droplet, as `ceil(count/32)` u32 words, bit b of
  // word b>>5 = block b's membership. Systematic ids return a single bit.
  // A row that comes out all zero gets bit (id mod count) set instead.
  function coeffRow(window, id, count) {
    const words = new Uint32Array(Math.ceil(count / 32));
    if (id < count) {
      words[id >> 5] = (1 << (id & 31)) >>> 0;
      return words;
    }
    const seed = mix(window, id);
    let any = 0;
    for (let w = 0; w < words.length; w++) {
      let v = fmix((seed + Math.imul(w + 1, 0x9E3779B9)) >>> 0);
      // mask the tail beyond `count`
      const used = Math.min(32, count - w * 32);
      if (used < 32) v &= (used === 32 ? 0xFFFFFFFF : ((1 << used) >>> 0) - 1);
      words[w] = v >>> 0;
      any |= v;
    }
    if (!any) words[(id % count) >> 5] = (1 << ((id % count) & 31)) >>> 0;
    return words;
  }

  // Split bytes into padded windows of blocks.
  function makeWindows(bytes) {
    const windows = [];
    for (let off = 0; off < bytes.length; off += BLOCK * WINDOW) {
      const span = Math.min(bytes.length - off, BLOCK * WINDOW);
      const count = Math.ceil(span / BLOCK);
      const blocks = [];
      for (let b = 0; b < count; b++) {
        const blk = new Uint8Array(BLOCK);
        blk.set(bytes.subarray(off + b * BLOCK, Math.min(bytes.length, off + (b + 1) * BLOCK)));
        blocks.push(blk);
      }
      windows.push({ blocks, count });
    }
    if (!windows.length) windows.push({ blocks: [new Uint8Array(BLOCK)], count: 1 });
    return windows;
  }

  // XOR-combine a window's blocks per the coefficient row.
  function makeDroplet(windowBlocks, windowIdx, id) {
    const count = windowBlocks.length;
    const row = coeffRow(windowIdx, id, count);
    const out = new Uint8Array(BLOCK);
    const o32 = new Uint32Array(out.buffer);
    for (let b = 0; b < count; b++) {
      if ((row[b >> 5] >>> (b & 31)) & 1) {
        const s32 = new Uint32Array(windowBlocks[b].buffer, windowBlocks[b].byteOffset, WORDS);
        for (let w = 0; w < WORDS; w++) o32[w] ^= s32[w];
      }
    }
    return out;
  }

  // Incremental Gaussian elimination for one window.
  class WindowDecoder {
    constructor(windowIdx, count) {
      this.window = windowIdx;
      this.count = count;
      this.words = Math.ceil(count / 32);
      this.pivots = new Array(count).fill(null);      // by leading bit
      this.rank = 0;
      this.received = 0;
    }

    _lead(row) {
      for (let w = 0; w < this.words; w++) {
        if (row[w]) return (w << 5) + (31 - Math.clz32(row[w] & (-row[w])));
      }
      return -1;
    }

    // Returns true if the droplet added rank.
    add(id, payload) {
      this.received++;
      const row = coeffRow(this.window, id, this.count);
      const pay = Uint8Array.from(payload.subarray(0, BLOCK));
      const p32 = new Uint32Array(pay.buffer);
      for (;;) {
        const lead = this._lead(row);
        if (lead < 0) return false;                    // linearly dependent
        const piv = this.pivots[lead];
        if (!piv) {
          this.pivots[lead] = { row, p32 };
          this.rank++;
          return true;
        }
        for (let w = 0; w < this.words; w++) row[w] = (row[w] ^ piv.row[w]) >>> 0;
        for (let w = 0; w < WORDS; w++) p32[w] ^= piv.p32[w];
      }
    }

    isComplete() { return this.rank === this.count; }

    // Back-substitute to plain blocks. Only valid when complete.
    solve() {
      if (!this.isComplete()) return null;
      for (let b = this.count - 1; b >= 0; b--) {
        const piv = this.pivots[b];
        // clear bit b from every row above that still carries it
        for (let a = 0; a < b; a++) {
          const p = this.pivots[a];
          if ((p.row[b >> 5] >>> (b & 31)) & 1) {
            for (let w = 0; w < this.words; w++) p.row[w] = (p.row[w] ^ piv.row[w]) >>> 0;
            for (let w = 0; w < WORDS; w++) p.p32[w] ^= piv.p32[w];
          }
        }
      }
      return this.pivots.map((p) => new Uint8Array(p.p32.buffer));
    }
  }

  const Fountain = { BLOCK, WINDOW, mix, fmix, coeffRow, makeWindows, makeDroplet, WindowDecoder };
  root.Fountain = Fountain;
  if (typeof module !== 'undefined' && module.exports) module.exports = Fountain;
})(typeof globalThis !== 'undefined' ? globalThis : this);
