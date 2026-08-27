'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Modem = require('../modem.js');
const { rng } = require('./helpers/channel.js');

function randomFile(n, r) { return new Uint8Array(n).map(() => Math.floor(r() * 256)); }

test('sender lays out START every 16 data frames plus a trailing START', () => {
  const s = new Modem.Sender(new Uint8Array(40 * 32), 'x.bin', { session: 2 });
  const seq = s.passSequence();
  assert.strictEqual(seq.length, 40 + 3 + 1);
  assert.strictEqual(Modem.parseFrame(seq[0]).kind, Modem.KIND.START);
  assert.strictEqual(Modem.parseFrame(seq[17]).kind, Modem.KIND.START);
  assert.strictEqual(Modem.parseFrame(seq[seq.length - 1]).kind, Modem.KIND.START);
});

test('receiver completes a lossy carousel over three passes', () => {
  const r = rng(7);
  const file = randomFile(5000, r);
  const s = new Modem.Sender(file, 'five.bin', { session: 5 });
  const rx = new Modem.Receiver();
  let pass = 0;
  while (!rx.isComplete() && pass < 8) {
    for (const raw of s.passSequence()) {
      if (r() < 0.25) continue;               // frame lost on the air
      rx.accept(raw);
    }
    pass++;
  }
  assert.ok(rx.isComplete(), 'not complete after 8 passes, missing ' + rx.missing());
  assert.ok(pass >= 3 && pass <= 6, 'took ' + pass + ' passes');
  const out = rx.assemble();
  assert.strictEqual(out.crcOk, true);
  assert.strictEqual(out.name, 'five.bin');
  assert.deepStrictEqual(Buffer.from(out.bytes), Buffer.from(file));
});

test('last partial frame carries its own len', () => {
  const file = new Uint8Array(70).map((_, i) => i + 1);
  const s = new Modem.Sender(file, 'p', { session: 1 });
  assert.strictEqual(s.meta.totalFrames, 3);
  assert.strictEqual(Modem.parseFrame(s.dataFrames[2]).len, 6);
  const rx = new Modem.Receiver();
  for (const raw of s.passSequence()) rx.accept(raw);
  assert.deepStrictEqual(Buffer.from(rx.assemble().bytes), Buffer.from(file));
});

test('data before START is buffered, not lost', () => {
  const file = new Uint8Array(100).map((_, i) => i);
  const s = new Modem.Sender(file, 'b', { session: 4 });
  const rx = new Modem.Receiver();
  for (const raw of s.dataFrames) assert.strictEqual(rx.accept(raw).kind, 'buffered');
  assert.strictEqual(rx.isComplete(), false);
  assert.strictEqual(rx.accept(s.startFrame).kind, 'start');
  assert.strictEqual(rx.isComplete(), true);
});

test('frames from another session do not pollute the current file', () => {
  const a = new Modem.Sender(new Uint8Array(64).fill(1), 'a', { session: 1 });
  const b = new Modem.Sender(new Uint8Array(64).fill(2), 'b', { session: 2 });
  const rx = new Modem.Receiver();
  rx.accept(a.startFrame);
  rx.accept(b.dataFrames[0]);
  rx.accept(b.dataFrames[1]);
  assert.strictEqual(rx.missing(), 2);
  rx.accept(a.dataFrames[0]);
  rx.accept(a.dataFrames[1]);
  assert.strictEqual(rx.isComplete(), true);
  assert.deepStrictEqual(Buffer.from(rx.assemble().bytes), Buffer.from(a.bytes));
  // Switching to session b picks up the buffered frames.
  rx.accept(b.startFrame);
  assert.strictEqual(rx.isComplete(), true);
  assert.deepStrictEqual(Buffer.from(rx.assemble().bytes), Buffer.from(b.bytes));
});

test('a duplicate seq with different bytes replaces and re-checks CRC-32', () => {
  const file = new Uint8Array(64).map((_, i) => i * 3);
  const s = new Modem.Sender(file, 'r', { session: 6 });
  const rx = new Modem.Receiver();
  rx.accept(s.startFrame);
  // Forge a frame with a valid CRC-16 but wrong content, as if CRC-16 had missed an error.
  const forged = Modem.buildFrame({ kind: Modem.KIND.DATA, session: 6, seq: 0, len: 32, payload: new Uint8Array(32).fill(9) });
  assert.strictEqual(rx.accept(forged).kind, 'data');
  assert.strictEqual(rx.accept(s.dataFrames[1]).kind, 'data');
  assert.strictEqual(rx.isComplete(), false);
  assert.strictEqual(rx.accept(s.dataFrames[0]).kind, 'replaced');
  assert.strictEqual(rx.isComplete(), true);
  assert.strictEqual(rx.accept(s.dataFrames[0]).kind, 'dup');
});

test('corrupt frames are rejected by CRC-16', () => {
  const s = new Modem.Sender(new Uint8Array(10), 'c', { session: 0 });
  const rx = new Modem.Receiver();
  const bad = s.startFrame.slice(); bad[5] ^= 0x10;
  assert.strictEqual(rx.accept(bad).kind, 'crcfail');
  assert.strictEqual(rx.stats.crcFail, 1);
});

test('empty file completes on START alone', () => {
  const s = new Modem.Sender(new Uint8Array(0), 'empty', { session: 3 });
  const rx = new Modem.Receiver();
  rx.accept(s.startFrame);
  assert.strictEqual(rx.isComplete(), true);
  assert.strictEqual(rx.assemble().bytes.length, 0);
});
