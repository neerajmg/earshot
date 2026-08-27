'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Modem = require('../modem.js');

test('hamming code words are distinct and have min distance 4', () => {
  const words = Array.from(Modem.HAM_ENC);
  for (let a = 0; a < 16; a++) {
    for (let b = a + 1; b < 16; b++) {
      let dist = 0, x = words[a] ^ words[b];
      while (x) { dist += x & 1; x >>= 1; }
      assert.ok(dist >= 4, `d(${a},${b}) = ${dist}`);
    }
  }
});

test('hamming corrects every single bit flip', () => {
  for (let n = 0; n < 16; n++) {
    const cw = Modem.HAM_ENC[n];
    const clean = Modem.hammingDecode(new Uint8Array([cw, Modem.HAM_ENC[0]]));
    assert.strictEqual(clean.bytes[0] >> 4, n);
    assert.strictEqual(clean.corrected, 0);
    assert.strictEqual(clean.uncorrectable, 0);
    for (let bit = 0; bit < 8; bit++) {
      const r = Modem.hammingDecode(new Uint8Array([cw ^ (1 << bit), Modem.HAM_ENC[0]]));
      assert.strictEqual(r.bytes[0] >> 4, n, `nibble ${n} bit ${bit}`);
      assert.strictEqual(r.corrected, 1);
      assert.strictEqual(r.uncorrectable, 0);
    }
  }
});

test('hamming flags every double bit flip as uncorrectable', () => {
  for (let n = 0; n < 16; n++) {
    const cw = Modem.HAM_ENC[n];
    for (let i = 0; i < 8; i++) {
      for (let j = i + 1; j < 8; j++) {
        const r = Modem.hammingDecode(new Uint8Array([cw ^ (1 << i) ^ (1 << j), Modem.HAM_ENC[0]]));
        assert.strictEqual(r.uncorrectable, 1, `nibble ${n} bits ${i},${j}`);
        assert.strictEqual(r.corrected, 0);
      }
    }
  }
});

test('hamming encode/decode round trip on bytes', () => {
  const src = new Uint8Array(256).map((_, i) => i);
  const coded = Modem.hammingEncode(src);
  assert.strictEqual(coded.length, 512);
  const r = Modem.hammingDecode(coded);
  assert.deepStrictEqual(Array.from(r.bytes), Array.from(src));
});
