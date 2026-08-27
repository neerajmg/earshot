'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Chirp = require('../chirp.js');
const Modem = require('../modem.js');
const DSP = require('../dsp.js');
const ch = require('./helpers/channel.js');

const FS = 48000;
const CH = Chirp.makeChirp(FS);

function detectAll(signal, opts) {
  const found = [];
  const det = new Chirp.Detector(FS, { onDetect: (d) => found.push(d) }, opts);
  for (let o = 0; o < signal.length; o += 4096) det.push(signal.subarray(o, Math.min(signal.length, o + 4096)));
  return { found, det };
}

function embed(offset, tail, r, level) {
  const parts = [ch.noise(offset, level === undefined ? 1e-4 : level, r), CH, ch.noise(tail, level === undefined ? 1e-4 : level, r)];
  return ch.concat(parts);
}

test('clean chirp: exact timing, one detection', () => {
  const r = ch.rng(1);
  const x = embed(30000, 30000, r);
  const { found } = detectAll(x);
  assert.strictEqual(found.length, 1);
  assert.ok(Math.abs(found[0].tEnd - (30000 + CH.length)) <= 24, 'err ' + (found[0].tEnd - (30000 + CH.length)));
});

test('detects at -5 dB in-band SNR (processing gain)', () => {
  // -5 dB across the 4 kHz swept band = about -12.8 dB across the full
  // 24 kHz of white noise.
  const r = ch.rng(2);
  const clean = embed(30000, 30000, r, 0);
  const x = ch.awgn(clean, -12.8, r);
  const { found } = detectAll(x);
  assert.strictEqual(found.length, 1, 'detections ' + found.length);
  assert.ok(Math.abs(found[0].tEnd - (30000 + CH.length)) <= 48, 'err ' + (found[0].tEnd - (30000 + CH.length)));
});

test('survives a 20 dB comb across the band', () => {
  const r = ch.rng(3);
  const x = ch.awgn(ch.comb(embed(30000, 30000, r, 0), FS, 600, 20, r), 10, r);
  const { found } = detectAll(x);
  assert.strictEqual(found.length, 1);
  assert.ok(Math.abs(found[0].tEnd - (30000 + CH.length)) <= 48, 'err ' + (found[0].tEnd - (30000 + CH.length)));
});

test('multipath: first-peak picking keeps timing on the direct path', () => {
  for (const [name, taps] of [['measured', ch.ROOM_MEASURED], ['bad', ch.ROOM_BAD]]) {
    const r = ch.rng(4);
    const x = ch.awgn(ch.echoesFrac(embed(30000, 30000, r, 0), FS, taps), 10, r);
    const { found } = detectAll(x);
    assert.strictEqual(found.length, 1, name);
    const err = found[0].tEnd - (30000 + CH.length);
    assert.ok(Math.abs(err) <= 48, `${name} err ${err}`);
  }
});

test('timing error stays under 1 ms across 40 noisy multipath trials', () => {
  const errs = [];
  for (let t = 0; t < 40; t++) {
    const r = ch.rng(100 + t);
    const off = 24000 + r.int(9600);
    const y = ch.awgn(ch.echoesFrac(embed(off, 24000, r, 0), FS, ch.ROOM_MEASURED), -8, r);
    const { found } = detectAll(y);
    assert.strictEqual(found.length, 1, 'trial ' + t + ': ' + found.length + ' detections');
    errs.push(Math.abs(found[0].tEnd - (off + CH.length)));
  }
  errs.sort((a, b) => a - b);
  assert.ok(errs[errs.length - 1] <= 48, 'worst of 40 trials: ' + errs[errs.length - 1] + ' samples');
});

test('unbothered by 200 ppm of clock offset', () => {
  const r = ch.rng(5);
  const x = ch.sfo(embed(30000, 30000, r), FS, 200);
  const { found } = detectAll(x);
  assert.strictEqual(found.length, 1);
  assert.ok(Math.abs(found[0].tEnd - (30000 + CH.length)) <= 96, 'err ' + (found[0].tEnd - (30000 + CH.length)));
});

test('five seconds of noise: no detections', () => {
  const r = ch.rng(6);
  const { found, det } = detectAll(ch.noise(5 * FS, 0.3, r));
  assert.strictEqual(found.length, 0, 'false detections ' + found.length);
});

test('five seconds of FSK modem signal: no detections', () => {
  const r = ch.rng(7);
  const payload = new Uint8Array(32).map(() => r.int(256));
  const frames = [];
  for (let i = 0; i < 3; i++) frames.push(Modem.buildFrame({ kind: 1, session: 1, seq: i, len: 32, payload }));
  const x = ch.concat(frames.map((f) => DSP.modulateFrame(Modem.frameToBits(f, 0), Modem.PRESETS.robust, FS)));
  const { found } = detectAll(x);
  assert.strictEqual(found.length, 0, 'false detections on FSK ' + found.length);
});

test('two chirps in one stream are both found', () => {
  const r = ch.rng(8);
  const gap = ch.noise(24000, 1e-4, r);
  const x = ch.concat([gap, CH, gap, CH, gap]);
  const { found } = detectAll(x);
  assert.strictEqual(found.length, 2);
  assert.ok(Math.abs(found[0].tEnd - (24000 + CH.length)) <= 24);
  assert.ok(Math.abs(found[1].tEnd - (24000 + CH.length + 24000 + CH.length)) <= 24);
});

test('analyzeIR sees the late wall tap of the bad room and separates the rooms', () => {
  const r = ch.rng(9);
  const x = ch.awgn(ch.echoesFrac(embed(30000, 30000, r, 0), FS, ch.ROOM_BAD), 30, r);
  const ir = Chirp.analyzeIR(x, FS);
  assert.ok(ir, 'no detection');
  // amplitude-dB display: the -15 dB tap at 11.7 ms appears near its level
  const at = (ms) => ir.irDb[Math.round((ms + ir.preMs) * ir.bbFs / 1000)];
  // superposed compressed pulses read a few dB hot; the window allows it
  assert.ok(at(11.7) > -22 && at(11.7) < -4, '11.7 ms tap at ' + at(11.7).toFixed(1) + ' dB');
  assert.ok(at(8) < at(11.7) - 3, 'valley before the tap: ' + at(8).toFixed(1));
  const r2 = ch.rng(10);
  const y = ch.awgn(ch.echoesFrac(embed(30000, 30000, r2, 0), FS, ch.ROOM_MEASURED), 30, r2);
  const ir2 = Chirp.analyzeIR(y, FS);
  assert.ok(ir2, 'no detection in the measured room');
  // energy beyond a 5.33 ms prefix has to separate the two rooms clearly
  assert.ok(ir.beyond533Db > -28, 'bad room beyond 5.33 ms: ' + ir.beyond533Db.toFixed(1) + ' dB');
  assert.ok(ir2.beyond533Db < -32, 'measured room beyond 5.33 ms: ' + ir2.beyond533Db.toFixed(1) + ' dB');
  assert.ok(ir.beyond533Db - ir2.beyond533Db > 6, 'separation ' + (ir.beyond533Db - ir2.beyond533Db).toFixed(1) + ' dB');
});
