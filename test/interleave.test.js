'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Modem = require('../modem.js');

const { ROWS, COLS } = Modem.FRAME;

test('bits <-> bytes round trip, MSB first', () => {
  const bytes = new Uint8Array([0x80, 0x01, 0xA5]);
  const bits = Modem.bytesToBits(bytes);
  assert.deepStrictEqual(Array.from(bits.slice(0, 8)), [1, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepStrictEqual(Array.from(Modem.bitsToBytes(bits)), Array.from(bytes));
});

test('interleave/deinterleave round trip', () => {
  const bits = new Uint8Array(ROWS * COLS).map((_, i) => (i * 7 + 3) % 2);
  const il = Modem.interleave(bits, ROWS, COLS);
  assert.notDeepStrictEqual(Array.from(il), Array.from(bits));
  assert.deepStrictEqual(Array.from(Modem.deinterleave(il, ROWS, COLS)), Array.from(bits));
});

test('a burst of ROWS consecutive air bits hits each codeword once', () => {
  const raw = new Uint8Array(Modem.FRAME.RAW).map((_, i) => i * 37);
  const air = Modem.frameToBits(raw);
  for (const start of [0, 5, 100, 300, air.length - ROWS]) {
    const hit = air.slice();
    for (let i = 0; i < ROWS; i++) hit[start + i] ^= 1;
    const r = Modem.bitsToFrame(hit);
    assert.strictEqual(r.uncorrectable, 0, 'start ' + start);
    assert.strictEqual(r.corrected, ROWS, 'start ' + start);
    assert.deepStrictEqual(Array.from(r.raw), Array.from(raw));
  }
});
