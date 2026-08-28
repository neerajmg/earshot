'use strict';
// Regression net for the receive side: the defects a QA pass found in the
// OFDM product path. Every test here failed on the code as shipped in 0.9.0
// unless its comment says otherwise. No audio hardware, no network, no
// Math.random - the channel helper's seeded rng is the only randomness.
const test = require('node:test');
const assert = require('node:assert');
const Air = require('../air.js');
const FFT = require('../fft.js');
const Modem = require('../modem.js');
const ch = require('./helpers/channel.js');
require('../air.js');                                  // globals the worker core reads
const { createWorkerCore } = require('../worker.js');

const FS = 48000;

function randomBytes(n, seed) {
  const r = ch.rng(seed);
  return new Uint8Array(n).map(() => r.int(256));
}

// Pushes frames from `tx` into `rx` with a little silence between them,
// exactly as a quiet room delivers them. Stops on `until` or after `cap`.
function pump(rx, tx, r, cap, until) {
  let n = 0;
  while (n < cap && !(until ? until() : rx.result)) {
    rx.push(ch.noise(800, 1e-4, r));
    rx.push(tx.nextFrame());
    n++;
  }
  return n;
}

// A sender whose manifest says something other than the truth.
async function preparedWithManifest(bytes, name, patch) {
  const prep = await Air.prepare(bytes, name);
  const good = Air.parseManifest(prep.manifest);
  prep.manifest = Air.packManifest(Object.assign({}, good, patch));
  return prep;
}

// ------------------------------------------------------------------ H1

test('H1: a file CRC-32 mismatch never latches a result and never claims success', async () => {
  const r = ch.rng(101);
  const bytes = randomBytes(2000, 102);
  // The manifest carries the wrong file CRC-32, so assembly can never check out.
  const prep = await Air.prepare(bytes, 'wrong-crc.bin');
  const good = Air.parseManifest(prep.manifest);
  prep.manifest = Air.packManifest(Object.assign({}, good, { crc32: (good.crc32 ^ 1) >>> 0 }));

  const completes = [];
  const rx = new Air.Receiver(FS, { onComplete: (res) => completes.push({ name: res.manifest.name, crcOk: res.crcOk }) });
  pump(rx, new Air.Sender(prep, { session: 1, papr: false }), r, 8, () => false);

  assert.deepStrictEqual(completes, [], 'onComplete fired for a transfer that failed its CRC-32');
  assert.strictEqual(rx.result, null, 'a failed assembly must not latch a result');
  assert.strictEqual(await rx.file(), null, 'file() must stay empty, not throw');

  // The receiver has to stay usable: a clean file behind the broken one lands.
  const clean = randomBytes(1500, 103);
  const prepClean = await Air.prepare(clean, 'clean.bin');
  pump(rx, new Air.Sender(prepClean, { session: 2, papr: false }), r, 12);
  const file = await rx.file();
  assert.ok(file, 'the receiver stopped working after a CRC-32 failure');
  assert.strictEqual(file.name, 'clean.bin');
  assert.strictEqual(Buffer.compare(Buffer.from(file.bytes), Buffer.from(clean)), 0);
  assert.deepStrictEqual(completes.map((c) => c.name), ['clean.bin']);
  assert.strictEqual(completes[0].crcOk, true);
});

test('H1: a file CRC-32 mismatch is reported once through onFailed and counted', async () => {
  const r = ch.rng(104);
  const bytes = randomBytes(2000, 105);
  const prep = await Air.prepare(bytes, 'wrong-crc.bin');
  const good = Air.parseManifest(prep.manifest);
  prep.manifest = Air.packManifest(Object.assign({}, good, { crc32: (good.crc32 ^ 1) >>> 0 }));

  const failed = [];
  const rx = new Air.Receiver(FS, { onFailed: (info) => failed.push(info) });
  pump(rx, new Air.Sender(prep, { session: 1, papr: false }), r, 8, () => false);

  assert.ok(failed.length >= 1, 'onFailed was never called for a CRC-32 failure');
  assert.strictEqual(failed[0].recovering, true);
  assert.strictEqual(failed[0].manifest.name, 'wrong-crc.bin');
  assert.ok(rx.stats.fileCrcFail >= 1, 'stats.fileCrcFail did not count the failure');
});

// ----------------------------------------------------------------- H1b

test('H1b: a poisoned window is rebuilt, not held forever', async () => {
  // W2 makes a droplet trailer CRC-32, so a corrupt payload behind a good
  // trailer is a 2^-32 event rather than a 2^-16 one. It is still possible,
  // and the recovery path is what this pins: poison one solved row directly
  // and the receiver must throw the window away and refill it.
  const r = ch.rng(111);
  const bytes = randomBytes(3000, 112);
  const prep = await Air.prepare(bytes, 'poison.bin');
  const tx = new Air.Sender(prep, { session: 7, papr: false });
  const rx = new Air.Receiver(FS);

  let poisoned = false, n = 0;
  while (n < 30 && !(rx.result && rx.result.crcOk)) {
    rx.push(ch.noise(800, 1e-4, r));
    rx.push(tx.nextFrame());
    n++;
    if (!poisoned) {
      const dec = rx.decoders.get(0);
      const piv = dec && dec.pivots.find((p) => p);
      if (piv) { piv.p32[0] = (piv.p32[0] ^ 0x5555) >>> 0; poisoned = true; }
    }
  }
  assert.ok(poisoned, 'the test never managed to poison a window');
  const file = await rx.file();
  assert.ok(file, `no file after ${n} frames: the poisoned window was never rebuilt`);
  assert.strictEqual(Buffer.compare(Buffer.from(file.bytes), Buffer.from(bytes)), 0);
  assert.ok(rx.stats.fileCrcFail >= 1, 'the bad assembly should have been counted');
});

// ------------------------------------------------------------------ H2

test('H2: inconsistent manifests are dropped without a throw, and a good one still lands', async () => {
  const r = ch.rng(121);
  const bytes = new Uint8Array(300).map((_, i) => i & 0xFF);
  assert.strictEqual(typeof Air.MAX_PAYLOAD, 'number', 'air.js must export MAX_PAYLOAD, the manifest size cap');

  const cases = [
    ['winCount 5 for a 300-byte file', { winCount: 5, size: 300 }],
    ['winCount 0', { winCount: 0, size: 300 }],
    ['size past the cap', { winCount: Math.ceil((Air.MAX_PAYLOAD + 1) / 65536), size: Air.MAX_PAYLOAD + 1 }],
  ];
  const completed = [];
  const rx = new Air.Receiver(FS, { onComplete: (r) => completed.push(r.manifest.name) });
  for (const [label, patch] of cases) {
    const prep = await preparedWithManifest(bytes, 'bad.bin', patch);
    const tx = new Air.Sender(prep, { session: 1, papr: false });
    pump(rx, tx, r, 2, () => false);                   // must not throw
    assert.strictEqual(rx.manifest, null, `${label}: the receiver adopted it`);
  }
  // The retired 'Ea' magic (W1) is a fourth way to be wrong.
  const prepOld = await Air.prepare(bytes, 'old.bin');
  const m = prepOld.manifest;
  m[0] = 0x45; m[1] = 0x61;
  const crc = Modem.crc16(m, 0, m.length - 2);
  m[m.length - 2] = crc >> 8; m[m.length - 1] = crc & 0xFF;
  pump(rx, new Air.Sender(prepOld, { session: 2, papr: false }), r, 2, () => false);
  assert.strictEqual(rx.manifest, null, "a manifest with the retired 'Ea' magic was adopted");
  assert.deepStrictEqual(completed, [], 'an inconsistent manifest completed a transfer');

  assert.ok(rx.stats.manifestBad >= 4, `stats.manifestBad counted ${rx.stats.manifestBad} of 4 rejections`);

  // Same receiver, a manifest that adds up: it has to work.
  const good = await Air.prepare(bytes, 'good.bin');
  pump(rx, new Air.Sender(good, { session: 3, papr: false }), r, 6);
  const file = await rx.file();
  assert.ok(file, 'a valid transfer after four bad manifests never completed');
  assert.strictEqual(file.name, 'good.bin');
  assert.strictEqual(Buffer.compare(Buffer.from(file.bytes), Buffer.from(bytes)), 0);
});

// ------------------------------------------------------------------ M5

test('M5: two senders alternating do not deadlock the receiver', async () => {
  const a = randomBytes(3000, 131);
  const b = randomBytes(2500, 132);
  const pa = await Air.prepare(a, 'a.bin');
  const pb = await Air.prepare(b, 'b.bin');
  const ta = new Air.Sender(pa, { session: 1, papr: false });
  const tb = new Air.Sender(pb, { session: 2, papr: false });
  const completes = [];
  const rx = new Air.Receiver(FS, { onComplete: (res) => completes.push(res.manifest.name) });
  const r = ch.rng(133);
  let n = 0;
  for (; n < 30 && !completes.length; n++) {
    rx.push(ch.noise(800, 1e-4, r));
    rx.push((n % 2 ? tb : ta).nextFrame());
  }
  assert.ok(completes.length, `neither file finished in ${n} alternating frames`);
  const file = await rx.file();
  assert.ok(file, 'complete fired but file() came back empty');
  const want = file.name === 'a.bin' ? a : b;
  assert.strictEqual(Buffer.compare(Buffer.from(file.bytes), Buffer.from(want)), 0);
});

// ---------------------------------------------------------------- reset

test('reset lets the same bytes, and the same bytes renamed, be received again', async () => {
  // Passes on 0.9.0: nothing in the suite drove {type:"reset"} at all, and
  // the page's second-transfer story rests on it.
  const out = [];
  const handle = createWorkerCore((m) => out.push(m));
  await handle({ type: 'init', fs: FS });
  const r = ch.rng(141);
  const bytes = randomBytes(1500, 142);

  const drive = async (prep, session) => {
    const tx = new Air.Sender(prep, { session, papr: false });
    const before = out.length;
    let g = 0;
    while (!out.slice(before).some((m) => m.type === 'complete') && g++ < 15) {
      await handle({ type: 'push', buf: ch.noise(800, 1e-4, r).buffer });
      await handle({ type: 'push', buf: tx.nextFrame().buffer.slice(0) });
    }
    return out.slice(before).filter((m) => m.type === 'complete');
  };

  const first = await Air.prepare(bytes, 'first.bin');
  assert.deepStrictEqual((await drive(first, 1)).map((m) => m.name), ['first.bin']);

  await handle({ type: 'reset' });
  assert.deepStrictEqual((await drive(first, 2)).map((m) => m.name), ['first.bin'],
    'after reset the same bytes did not complete again');

  await handle({ type: 'reset' });
  const renamed = await Air.prepare(bytes, 'renamed.bin');
  assert.deepStrictEqual((await drive(renamed, 3)).map((m) => m.name), ['renamed.bin'],
    'after reset the same bytes under a new name kept the old name');

  await handle({ type: 'file' });
  const file = out.filter((m) => m.type === 'file').pop();
  assert.strictEqual(file.name, 'renamed.bin');
  assert.strictEqual(Buffer.compare(Buffer.from(new Uint8Array(file.bytes)), Buffer.from(bytes)), 0);
});

test('a second send of the same bytes under a new name completes again without a reset', async () => {
  // The page never posts reset; "Listen" reuses the worker. On 0.9.0 the
  // second transfer is swallowed because the manifest CRC-32 has not moved.
  const out = [];
  const handle = createWorkerCore((m) => out.push(m));
  await handle({ type: 'init', fs: FS });
  const r = ch.rng(151);
  const bytes = randomBytes(1500, 152);
  const drive = async (prep, session) => {
    const tx = new Air.Sender(prep, { session, papr: false });
    const before = out.length;
    let g = 0;
    while (!out.slice(before).some((m) => m.type === 'complete') && g++ < 15) {
      await handle({ type: 'push', buf: ch.noise(800, 1e-4, r).buffer });
      await handle({ type: 'push', buf: tx.nextFrame().buffer.slice(0) });
    }
    return out.slice(before).filter((m) => m.type === 'complete');
  };
  await drive(await Air.prepare(bytes, 'first.bin'), 1);
  const again = await drive(await Air.prepare(bytes, 'renamed.bin'), 2);
  assert.deepStrictEqual(again.map((m) => m.name), ['renamed.bin'],
    'the same bytes under a new name never completed a second time');
});

// ------------------------------------------------------- 44.1 kHz capture

test('the page 44.1 kHz path decodes: 48k on the air, 44.1k mic, 4096-sample chunks back to 48k', async () => {
  // Passes on 0.9.0. Nothing covered the resample the page actually runs
  // (earshot.js feed() resamples each capture chunk on its own), and every
  // frame-layout change here risks it, so it earns its place as a guard.
  const r = ch.rng(161);
  const bytes = randomBytes(1200, 162);
  const prep = await Air.prepare(bytes, 'mic441.bin');
  const tx = new Air.Sender(prep, { session: 6 });      // shipped default: PAPR on
  const rx = new Air.Receiver(FS);
  const CHUNK = 4096;
  let pending = new Float32Array(0);
  const capture = (x) => {
    const merged = new Float32Array(pending.length + x.length);
    merged.set(pending); merged.set(x, pending.length);
    pending = merged;
    while (pending.length >= CHUNK) {
      const c = pending.subarray(0, CHUNK);
      pending = pending.slice(CHUNK);
      rx.push(FFT.sincResample(c, 44100, FS));
    }
  };
  let n = 0;
  while (!rx.result && n < 12) {
    const air = ch.concat([ch.noise(800, 1e-4, r), tx.nextFrame()]);
    capture(FFT.sincResample(air, FS, 44100));          // what a 44.1 kHz device hears
    n++;
  }
  if (pending.length) rx.push(FFT.sincResample(pending, 44100, FS));
  const file = await rx.file();
  assert.ok(file, `no file after ${n} frames at 44.1 kHz: ${JSON.stringify(rx.stats)}`);
  assert.strictEqual(rx.stats.sigFail, 0, 'signalling failed on a clean 44.1 kHz capture');
  assert.strictEqual(Buffer.compare(Buffer.from(file.bytes), Buffer.from(bytes)), 0);
});
