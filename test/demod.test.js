'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Modem = require('../modem.js');
const DSP = require('../dsp.js');
const ch = require('./helpers/channel.js');

const ROBUST = Modem.PRESETS.robust, FAST = Modem.PRESETS.fast;

function randomFrames(n, r) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const payload = new Uint8Array(32).map(() => r.int(256));
    out.push(Modem.buildFrame({ kind: Modem.KIND.DATA, session: 1, seq: i, len: 32, payload }));
  }
  return out;
}

// Renders raw frames back to back (each with its gap) at fs.
function render(frames, preset, fs, opts) {
  return ch.concat(frames.map((raw) => DSP.modulateFrame(Modem.frameToBits(raw), preset, fs, opts)));
}

// Feeds a signal through a Demodulator in chunks and collects decoded frames.
function decode(signal, preset, fs, chunk) {
  chunk = chunk || 4096;
  const frames = [], syncs = [], corrections = [];
  const demod = new DSP.Demodulator(preset, fs, {
    onSync: (s) => syncs.push(s),
    onFrame: (f) => {
      const d = Modem.bitsToFrame(f.bits);
      const p = Modem.parseFrame(d.raw);
      corrections.push(d.corrected);
      if (p.crcOk) frames.push({ seq: p.seq, raw: d.raw, corrected: d.corrected, info: f });
      return p.crcOk;
    },
  });
  for (let off = 0; off < signal.length; off += chunk) demod.push(signal.subarray(off, Math.min(signal.length, off + chunk)));
  return { frames, syncs, corrections, demod };
}

function seqs(res) { return res.frames.map((f) => f.seq); }
function range(n) { return Array.from({ length: n }, (_, i) => i); }

test('clean loopback decodes every frame, both presets, three rates', () => {
  const r = ch.rng(11);
  const frames = randomFrames(5, r);
  for (const preset of [ROBUST, FAST]) {
    for (const fs of [16000, 44100, 48000]) {
      const x = ch.delay(render(frames, preset, fs), 1234, r);
      const res = decode(x, preset, fs);
      assert.deepStrictEqual(seqs(res), range(5), `${preset.name} ${fs}`);
      assert.strictEqual(res.demod.stats.falseSyncs, 0);
      for (const f of res.frames) assert.strictEqual(f.corrected, 0, `${preset.name} ${fs} clean should need no correction`);
      for (const f of res.frames) assert.deepStrictEqual(Array.from(f.raw), Array.from(frames[f.seq]));
    }
  }
});

test('chunk size does not matter', () => {
  const r = ch.rng(12);
  const frames = randomFrames(3, r);
  const x = ch.delay(render(frames, ROBUST, 48000), 777, r);
  for (const chunk of [1, 100, 4096, 65536, x.length]) {
    assert.deepStrictEqual(seqs(decode(x, ROBUST, 48000, chunk)), range(3), 'chunk ' + chunk);
  }
});

test('gain, clipping and DC offset do not matter', () => {
  const r = ch.rng(13);
  const frames = randomFrames(3, r);
  const x = ch.delay(render(frames, ROBUST, 48000), 500, r);
  assert.deepStrictEqual(seqs(decode(ch.gain(x, 0.01), ROBUST, 48000)), range(3), 'quiet');
  assert.deepStrictEqual(seqs(decode(ch.clip(ch.gain(x, 10), 1), ROBUST, 48000)), range(3), 'clipped');
  const dc = x.map((v) => v + 0.3);
  assert.deepStrictEqual(seqs(decode(dc, ROBUST, 48000)), range(3), 'dc');
});

test('AWGN sweep: all frames at 10 dB, most at 0 dB (full band SNR)', () => {
  const r = ch.rng(14);
  const frames = randomFrames(10, r);
  for (const [preset, fs] of [[ROBUST, 48000], [FAST, 48000]]) {
    const clean = ch.delay(render(frames, preset, fs), 2000, r);
    const at10 = decode(ch.awgn(clean, 10, r), preset, fs);
    assert.deepStrictEqual(seqs(at10), range(10), `${preset.name} at 10 dB`);
    const at0 = decode(ch.awgn(clean, 0, r), preset, fs);
    assert.ok(at0.frames.length >= 9, `${preset.name} at 0 dB got ${at0.frames.length}/10`);
    const atMinus5 = decode(ch.awgn(clean, -5, r), preset, fs);
    assert.ok(atMinus5.frames.length >= 5, `${preset.name} at -5 dB got ${atMinus5.frames.length}/10`);
  }
});

test('sender at 44.1 kHz, receiver at 48 kHz and the reverse', () => {
  const r = ch.rng(15);
  const frames = randomFrames(4, r);
  for (const [txFs, rxFs] of [[44100, 48000], [48000, 44100], [16000, 48000]]) {
    for (const preset of [ROBUST, FAST]) {
      const x = ch.resampleLinear(ch.delay(render(frames, preset, txFs), 300, r), txFs, rxFs);
      assert.deepStrictEqual(seqs(decode(x, preset, rxFs)), range(4), `${preset.name} ${txFs}->${rxFs}`);
    }
  }
});

test('clock drift of +-200 ppm', () => {
  const r = ch.rng(16);
  const frames = randomFrames(4, r);
  for (const ppm of [200, -200]) {
    for (const preset of [ROBUST, FAST]) {
      const x = ch.drift(ch.delay(render(frames, preset, 48000), 300, r), 48000, ppm);
      assert.deepStrictEqual(seqs(decode(x, preset, 48000)), range(4), `${preset.name} ${ppm} ppm`);
    }
  }
});

test('bandpass 1-3.5 kHz with noise', () => {
  const r = ch.rng(17);
  const frames = randomFrames(4, r);
  for (const preset of [ROBUST, FAST]) {
    const x = ch.awgn(ch.bandpass(ch.delay(render(frames, preset, 48000), 300, r), 48000, 1000, 3500), 10, r);
    assert.deepStrictEqual(seqs(decode(x, preset, 48000)), range(4), preset.name);
  }
});

test('a 60 ms dropout or noise burst inside a robust frame is corrected', () => {
  const r = ch.rng(18);
  const frames = randomFrames(2, r);
  const fs = 48000;
  const clean = ch.delay(render(frames, ROBUST, fs), 300, r);
  const inside = 300 + Math.round(200 * fs / ROBUST.baud);   // 200 symbols into frame 0 (payload region)
  for (const mode of ['zero', 'noise']) {
    const x = ch.burst(clean, inside, Math.round(0.06 * fs), r, mode);
    const res = decode(x, ROBUST, fs);
    assert.deepStrictEqual(seqs(res), [0, 1], mode);
    assert.ok(res.frames[0].corrected > 0, mode + ' should have needed corrections');
  }
});

test('room echo taps', () => {
  const r = ch.rng(19);
  const frames = randomFrames(4, r);
  const x = ch.awgn(ch.echoes(ch.delay(render(frames, ROBUST, 48000), 300, r), 48000), 15, r);
  const res = decode(x, ROBUST, 48000);
  assert.deepStrictEqual(seqs(res), range(4), 'robust');
  // The per-frame equaliser should have found something to correct here.
  assert.ok(res.syncs.filter((s) => s.dfe).length >= 3, 'dfe fitted on ' + res.syncs.filter((s) => s.dfe).length + ' of 4');
  // A -6 dB reflection 1.3 ms away is 1.5 symbols at 1200 baud and costs the
  // fast preset about 2 % raw BER, too much for Hamming. With a -10 dB desk it is fine.
  const mild = [[0.0013, -10], [0.011, -14], [0.019, -18]];
  const y = ch.awgn(ch.echoes(ch.delay(render(frames, FAST, 48000), 300, r), 48000, mild), 15, r);
  assert.deepStrictEqual(seqs(decode(y, FAST, 48000)), range(4), 'fast');
  // With the strong desk reflection the two-tap equaliser gets most frames, not all.
  const z = ch.awgn(ch.echoes(ch.delay(render(frames, FAST, 48000), 300, r), 48000), 15, r);
  assert.ok(decode(z, FAST, 48000).frames.length >= 2, 'fast with a -6 dB desk reflection');
});

test('noise floor used for a frame is the one at its sync, even in one huge chunk', () => {
  const r = ch.rng(25);
  const frames = randomFrames(4, r);
  // Half a second of lead-in so the first frame also has a measured floor.
  const x = ch.awgn(ch.delay(render(frames, ROBUST, 48000), 24000, r), 15, r);
  const res = decode(x, ROBUST, 48000, x.length);
  assert.deepStrictEqual(seqs(res), range(4));
  const margins = res.frames.map((f) => f.info.softMargin);
  for (const m of margins) assert.ok(m > 0.8, 'margins ' + margins.map((v) => v.toFixed(2)).join(' '));
  const snrs = res.syncs.map((s) => s.snrDb);
  assert.ok(Math.max(...snrs) - Math.min(...snrs) < 3, 'snr spread ' + snrs.map((v) => v.toFixed(1)).join(' '));
});

test('everything at once', () => {
  const r = ch.rng(20);
  const frames = randomFrames(6, r);
  let x = render(frames, ROBUST, 44100);
  x = ch.delay(x, 5000, r);
  x = ch.echoes(x, 44100);
  x = ch.bandpass(x, 44100, 800, 4000);
  x = ch.drift(x, 44100, 120);
  x = ch.resampleLinear(x, 44100, 48000);
  x = ch.gain(x, 0.2);
  x = ch.awgn(x, 8, r);
  assert.deepStrictEqual(seqs(decode(x, ROBUST, 48000)), range(6));
});

test('20-frame stream gives exactly 20 syncs and no false alarms', () => {
  const r = ch.rng(21);
  const frames = randomFrames(20, r);
  const x = ch.awgn(ch.delay(render(frames, FAST, 48000), 3000, r), 15, r);
  const res = decode(x, FAST, 48000);
  assert.strictEqual(res.syncs.length, 20);
  assert.deepStrictEqual(seqs(res), range(20));
  assert.strictEqual(res.demod.stats.falseSyncs, 0);
});

test('the tail of a frame plus silence is not mistaken for a sync', () => {
  const r = ch.rng(26);
  const frames = randomFrames(30, r);
  const x = ch.delay(render(frames, FAST, 44100), 300, r);
  const res = decode(x, FAST, 44100);
  assert.deepStrictEqual(seqs(res), range(30));
  assert.ok(res.demod.stats.falseSyncs <= 3, 'rejected candidates: ' + res.demod.stats.falseSyncs);
});

test('5 s of pure noise produces no frames', () => {
  const r = ch.rng(22);
  for (const preset of [ROBUST, FAST]) {
    const res = decode(ch.noise(5 * 48000, 0.3, r), preset, 48000);
    assert.strictEqual(res.frames.length, 0);
    assert.strictEqual(res.syncs.length, 0, preset.name + ' synced on noise');
  }
});

test('receiver joining mid-frame catches the next frame', () => {
  const r = ch.rng(23);
  const frames = randomFrames(3, r);
  const x = render(frames, ROBUST, 48000);
  const late = x.subarray(Math.round(x.length / 3 / 2));   // start halfway through frame 0
  const res = decode(late, ROBUST, 48000);
  assert.deepStrictEqual(seqs(res), [1, 2]);
});

test('sync report carries plausible SNR and balance', () => {
  const r = ch.rng(24);
  const frames = randomFrames(2, r);
  const x = ch.awgn(ch.delay(render(frames, ROBUST, 48000), 24000, r), 10, r);
  const res = decode(x, ROBUST, 48000);
  assert.strictEqual(res.syncs.length, 2);
  const s = res.syncs[1];
  assert.ok(s.snrDb > 15 && s.snrDb < 45, 'snr ' + s.snrDb);
  assert.ok(Math.abs(s.balanceDb) < 3, 'balance ' + s.balanceDb);
  assert.ok(s.corr >= 0.5 && s.corr <= 1.0001);
  assert.ok(s.syncErrors <= 1);
});
