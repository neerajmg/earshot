'use strict';
const test = require('node:test');
const assert = require('node:assert');
const DSP = require('../dsp.js');

test('wav encode/decode round trip at several rates', () => {
  for (const fs of [16000, 44100, 48000]) {
    const x = new Float32Array(1000).map((_, i) => 0.8 * Math.sin(i / 7));
    const buf = DSP.wavEncode(x, fs);
    assert.strictEqual(buf.byteLength, 44 + 2000);
    const r = DSP.wavDecode(buf);
    assert.strictEqual(r.fs, fs);
    assert.strictEqual(r.samples.length, 1000);
    for (let i = 0; i < 1000; i++) assert.ok(Math.abs(r.samples[i] - x[i]) < 1 / 32767 + 1e-6);
  }
});

test('wav encode accepts Int16Array and clips floats', () => {
  const i16 = new Int16Array([0, 32767, -32768, 1234]);
  const r = DSP.wavDecode(DSP.wavEncode(i16, 8000));
  assert.deepStrictEqual(Array.from(r.samples).map((v) => Math.round(v < 0 ? v * 32768 : v * 32767)), [0, 32767, -32768, 1234]);
  const hot = DSP.wavDecode(DSP.wavEncode(new Float32Array([2, -2]), 8000));
  assert.ok(hot.samples[0] > 0.99 && hot.samples[1] < -0.99);
});

test('wav decode takes channel 0 of stereo and reads float32', () => {
  // Build a stereo float32 WAV by hand.
  const n = 10, ch = 2;
  const buf = new ArrayBuffer(44 + n * ch * 4);
  const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * ch * 4, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 3, true); v.setUint16(22, ch, true);
  v.setUint32(24, 22050, true); v.setUint32(28, 22050 * ch * 4, true); v.setUint16(32, ch * 4, true); v.setUint16(34, 32, true);
  str(36, 'data'); v.setUint32(40, n * ch * 4, true);
  for (let i = 0; i < n; i++) { v.setFloat32(44 + i * 8, i / 10, true); v.setFloat32(48 + i * 8, -1, true); }
  const r = DSP.wavDecode(buf);
  assert.strictEqual(r.fs, 22050);
  assert.strictEqual(r.channels, 2);
  assert.deepStrictEqual(Array.from(r.samples).map((x) => Math.round(x * 10)), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('wav decode rejects non-WAV input', () => {
  assert.throws(() => DSP.wavDecode(new ArrayBuffer(100)));
});
