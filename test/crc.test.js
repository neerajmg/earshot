'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Modem = require('../modem.js');

const check = new Uint8Array(Buffer.from('123456789'));

test('crc16 CCITT-FALSE check value', () => {
  assert.strictEqual(Modem.crc16(check), 0x29B1);
});

test('crc16 honours start/end', () => {
  const padded = new Uint8Array(12);
  padded.set(check, 2);
  assert.strictEqual(Modem.crc16(padded, 2, 11), 0x29B1);
});

test('crc32 IEEE check value', () => {
  assert.strictEqual(Modem.crc32(check), 0xCBF43926);
  assert.strictEqual(Modem.crc32(new Uint8Array(0)), 0);
});

test('crc16 detects every single bit flip in a frame', () => {
  const raw = Modem.buildFrame({ kind: 1, session: 3, seq: 7, len: 32, payload: new Uint8Array(32).map((_, i) => i * 7) });
  for (let bit = 0; bit < 36 * 8; bit++) {
    const c = raw.slice();
    c[bit >> 3] ^= 1 << (7 - (bit & 7));
    assert.strictEqual(Modem.parseFrame(c).crcOk, false, 'bit ' + bit);
  }
});
