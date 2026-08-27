'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Modem = require('../modem.js');
const { rng } = require('./helpers/channel.js');

test('build/parse round trip', () => {
  const payload = new Uint8Array(32).map((_, i) => 255 - i);
  const raw = Modem.buildFrame({ kind: Modem.KIND.DATA, session: 9, seq: 0x1234, len: 20, payload });
  assert.strictEqual(raw.length, Modem.FRAME.RAW);
  const f = Modem.parseFrame(raw);
  assert.strictEqual(f.kind, 1);
  assert.strictEqual(f.session, 9);
  assert.strictEqual(f.seq, 0x1234);
  assert.strictEqual(f.len, 20);
  assert.strictEqual(f.crcOk, true);
  assert.deepStrictEqual(Array.from(f.payload), Array.from(payload));
});

test('frameToBits/bitsToFrame round trip is 608 bits', () => {
  const raw = Modem.buildFrame({ kind: 1, session: 1, seq: 1, len: 32, payload: new Uint8Array(32).fill(0x5A) });
  const bits = Modem.frameToBits(raw);
  assert.strictEqual(bits.length, Modem.FRAME.BITS);
  const r = Modem.bitsToFrame(bits);
  assert.deepStrictEqual(Array.from(r.raw), Array.from(raw));
  assert.strictEqual(r.corrected, 0);
});

test('one random flip in every codeword is corrected', () => {
  const r = rng(42);
  const raw = Modem.buildFrame({ kind: 1, session: 1, seq: 5, len: 32, payload: new Uint8Array(32).map(() => Math.floor(r() * 256)) });
  const bits = Modem.frameToBits(raw);
  const { ROWS, COLS } = Modem.FRAME;
  for (let row = 0; row < ROWS; row++) {
    const col = Math.floor(r() * COLS);
    bits[col * ROWS + row] ^= 1;
  }
  const d = Modem.bitsToFrame(bits);
  assert.strictEqual(d.corrected, ROWS);
  assert.strictEqual(d.uncorrectable, 0);
  assert.strictEqual(Modem.parseFrame(d.raw).crcOk, true);
});

test('two overlapping bursts break codewords and fail the CRC', () => {
  const raw = Modem.buildFrame({ kind: 1, session: 1, seq: 5, len: 32, payload: new Uint8Array(32).fill(1) });
  const bits = Modem.frameToBits(raw);
  const { ROWS } = Modem.FRAME;
  for (let i = 0; i < 20; i++) { bits[2 * ROWS + 10 + i] ^= 1; bits[4 * ROWS + 10 + i] ^= 1; }   // columns 2 and 4 are data bits
  const d = Modem.bitsToFrame(bits);
  assert.ok(d.uncorrectable > 0);
  assert.strictEqual(Modem.parseFrame(d.raw).crcOk, false);
});

test('START payload round trip and name truncation', () => {
  const meta = { size: 123456, crc32: 0xDEADBEEF, totalFrames: 3858, name: 'hello.txt' };
  const p = Modem.buildStart(meta);
  assert.strictEqual(p.length, 32);
  assert.deepStrictEqual(Modem.parseStart(p), meta);

  const long = Modem.parseStart(Modem.buildStart({ size: 1, crc32: 1, totalFrames: 1, name: 'a-very-long-file-name-with-many-chars.bin' }));
  assert.ok(Buffer.byteLength(long.name) <= Modem.NAME_MAX);
  assert.ok(long.name.startsWith('a-very-long'));

  const utf = Modem.parseStart(Modem.buildStart({ size: 1, crc32: 1, totalFrames: 1, name: 'ééééééééééééé.txt' }));
  assert.ok(Buffer.byteLength(utf.name) <= Modem.NAME_MAX);
  assert.ok(!utf.name.includes('�'));
});

test('per-pass scramblers round trip and change the air bits', () => {
  const raw = Modem.buildFrame({ kind: 1, session: 2, seq: 9, len: 32, payload: new Uint8Array(32).map((_, i) => i * 13) });
  const plain = Modem.frameToBits(raw, 0);
  for (let k = 0; k < Modem.SCRAMBLERS; k++) {
    const bits = Modem.frameToBits(raw, k);
    const d = Modem.bitsToFrame(bits);
    assert.deepStrictEqual(Array.from(d.raw), Array.from(raw), 'scrambler ' + k);
    assert.strictEqual(d.scrambler, k);
    assert.strictEqual(d.corrected, 0);
    if (k > 0) {
      let diff = 0;
      for (let i = 0; i < bits.length; i++) if (bits[i] !== plain[i]) diff++;
      assert.ok(diff > 200 && diff < 400, 'scrambler ' + k + ' flips ' + diff + ' of 608');
    }
  }
  assert.strictEqual(Modem.bitsToFrame(Modem.frameToBits(raw, Modem.SCRAMBLERS + 1)).scrambler, 1, 'pass index wraps');
  // a corrupted frame still reports the plain decode's counts
  const bad = Modem.frameToBits(raw, 2);
  const { ROWS } = Modem.FRAME;
  for (let i = 0; i < 40; i++) { bad[2 * ROWS + i] ^= 1; bad[4 * ROWS + i] ^= 1; }   // two data bits per codeword
  const d = Modem.bitsToFrame(bad);
  assert.strictEqual(Modem.parseFrame(d.raw).crcOk, false);
});
