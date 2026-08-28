'use strict';
// Regression net for the send side: airtime, the shipped PAPR default,
// boundary sizes and file names. Seeded randomness only.
const test = require('node:test');
const assert = require('node:assert');
const Air = require('../air.js');
const Fountain = require('../fountain.js');
const ch = require('./helpers/channel.js');

const FS = 48000;

function randomBytes(n, seed) {
  const r = ch.rng(seed);
  return new Uint8Array(n).map(() => r.int(256));
}

async function transfer(bytes, name, opts) {
  const o = opts || {};
  const r = ch.rng(o.seed || 1);
  const prep = o.prep || await Air.prepare(bytes, name, o.passphrase ? { passphrase: o.passphrase } : undefined);
  const tx = new Air.Sender(prep, { session: 9, papr: o.papr });
  const rx = new Air.Receiver(FS);
  let sent = 0;
  while (!rx.result && sent < (o.cap || 40)) {
    let f = tx.nextFrame();
    if (o.channel) f = o.channel(f, r);
    rx.push(ch.noise(800, 1e-4, r));
    rx.push(f);
    sent++;
  }
  return { rx, prep, sent, file: await rx.file(o.passphrase ? { passphrase: o.passphrase } : undefined) };
}

// ------------------------------------------------------------------ H3

// Frames to completion on a clean channel, counted at the byte layer so the
// airtime question can be asked about every size without minutes of DSP.
// It is the real Sender scheduling into the real fountain decoders; only
// the modulator and the microphone are missing.
function framesToComplete(prep, cap) {
  assert.strictEqual(typeof Air.MANIFEST_BYTES, 'number', 'air.js must export MANIFEST_BYTES');
  assert.strictEqual(typeof Air.DROPLET_BYTES, 'number', 'air.js must export DROPLET_BYTES');
  const tx = new Air.Sender(prep, { session: 1, papr: false });
  const decoders = prep.windows.map((w, i) => new Fountain.WindowDecoder(i, w.count));
  let n = 0;
  for (; n < cap; n++) {
    const frame = tx.frameBytes();
    const view = new DataView(frame.buffer, frame.byteOffset);
    for (let d = 0; d < Air.DROPLETS_PER_FRAME; d++) {
      const off = Air.MANIFEST_BYTES + d * Air.DROPLET_BYTES;
      const w = (frame[off] << 8) | frame[off + 1];
      decoders[w].add(view.getUint32(off + 2), frame.subarray(off + 6, off + 6 + Fountain.BLOCK));
    }
    if (decoders.every((d) => d.isComplete())) { n++; break; }
  }
  const out = new Uint8Array(prep.payload.length);
  let off = 0;
  for (const dec of decoders) {
    const blocks = dec.solve();
    assert.ok(blocks, 'a window never solved');
    for (const b of blocks) {
      const take = Math.min(Fountain.BLOCK, out.length - off);
      if (take > 0) out.set(b.subarray(0, take), off);
      off += take;
    }
  }
  return { frames: n, bytes: out };
}

test('H3: airtime stays inside 15 percent of Air.framesFor across the window boundary', async () => {
  assert.strictEqual(typeof Air.framesFor, 'function', 'air.js must export framesFor, the one airtime estimate');

  const rows = [];
  for (const size of [65536, 65537, 100000, 131072]) {
    const bytes = randomBytes(size, 1000 + (size & 0xFFFF));
    const prep = await Air.prepare(bytes, 'airtime.bin');
    assert.strictEqual(prep.flags & 1, 0, 'random bytes must not compress, or the estimate is about a different size');
    const est = Air.framesFor(prep.payload.length);
    const { frames, bytes: got } = framesToComplete(prep, 4000);
    assert.strictEqual(Buffer.compare(Buffer.from(got), Buffer.from(prep.payload)), 0, `${size}: rebuilt payload differs`);
    rows.push({ size, windows: prep.windows.length, frames, est });
  }
  for (const row of rows) {
    const ratio = row.frames / row.est;
    assert.ok(ratio <= 1.15 && ratio >= 0.85,
      `${row.size} B in ${row.windows} window(s) took ${row.frames} frames against an estimate of ${row.est} (${ratio.toFixed(2)}x)`);
  }
});

test('H3: the byte-layer frame count matches the real air', { skip: !process.env.EARSHOT_SLOW && 'set EARSHOT_SLOW=1' }, async () => {
  // Proof that framesToComplete above is not lying: the same file, all the
  // way through the modulator and demodulator, needs the same frames.
  const bytes = randomBytes(65537, 1234);
  const prep = await Air.prepare(bytes, 'airtime.bin');
  const modelled = framesToComplete(prep, 4000).frames;
  const t = await transfer(bytes, 'airtime.bin', { prep, seed: 2, papr: false, cap: 4000 });
  assert.ok(t.file, 'the acoustic run never completed');
  assert.strictEqual(Buffer.compare(Buffer.from(t.file.bytes), Buffer.from(bytes)), 0);
  assert.ok(Math.abs(t.sent - modelled) <= 2, `air took ${t.sent} frames, the byte-layer model said ${modelled}`);
});

// ----------------------------------------------------------------- PAPR

test('PAPR is on by default and the shipped default decodes', async () => {
  // Passes on 0.9.0. Every air test but one asks for papr:false while the
  // product ships PAPR on, so the default path had no plain coverage.
  const prep = await Air.prepare(randomBytes(64, 171), 'papr.bin');
  assert.strictEqual(new Air.Sender(prep, { session: 1 }).papr, true, 'PAPR must stay on unless asked off');

  const crest = (x) => {
    let peak = 0, sum = 0;
    for (const v of x) { peak = Math.max(peak, Math.abs(v)); sum += v * v; }
    return peak / Math.sqrt(sum / x.length);
  };
  const on = new Air.Sender(prep, { session: 1, papr: true }).nextFrame();
  const off = new Air.Sender(prep, { session: 1, papr: false }).nextFrame();
  assert.ok(crest(on) < crest(off),
    `PAPR reduction did nothing: crest ${crest(on).toFixed(2)} on, ${crest(off).toFixed(2)} off`);

  const bytes = randomBytes(2500, 172);
  const t = await transfer(bytes, 'papr.bin', { seed: 173, papr: true, channel: (f, r) => ch.awgn(f, 12, r) });
  assert.ok(t.file, `PAPR-on transfer never completed: ${JSON.stringify(t.rx.stats)}`);
  assert.strictEqual(Buffer.compare(Buffer.from(t.file.bytes), Buffer.from(bytes)), 0);
});

// ------------------------------------------------------- boundary sizes

test('boundary sizes around the block and the frame come back byte-identical', async () => {
  // Passes on 0.9.0. W2 moves the droplet size and the frame budget, so the
  // sizes that sit on a block edge need a net under them.
  for (const size of [0, 1, 255, 256, 257, 767, 768, 769]) {
    const bytes = randomBytes(size, 200 + size);
    const t = await transfer(bytes, `b${size}.bin`, { seed: 300 + size, papr: false, cap: 8 });
    assert.ok(t.file, `${size} B never completed`);
    assert.strictEqual(t.file.bytes.length, size, `${size} B came back ${t.file.bytes.length} B long`);
    assert.strictEqual(Buffer.compare(Buffer.from(t.file.bytes), Buffer.from(bytes)), 0, `${size} B differs`);
  }
});

// -------------------------------------------------------------- names

test('file names: unicode survives, long ones are cut on a character boundary', async () => {
  const body = new TextEncoder().encode('hi\n');
  const enc = new TextEncoder();
  const cases = [
    ['résumé 📄.txt', 'unicode inside 64 bytes must arrive exactly'],
    ['a' + 'é'.repeat(40) + '.txt', 'a cut that lands mid-character'],
    ['x'.repeat(60) + '.json', '65 bytes of ASCII'],
    ['', 'no name at all'],
  ];
  for (const [name, why] of cases) {
    const t = await transfer(body, name, { seed: 400 + name.length, papr: false, cap: 4 });
    assert.ok(t.file, `${why}: no file`);
    assert.strictEqual(Buffer.compare(Buffer.from(t.file.bytes), Buffer.from(body)), 0, `${why}: bytes differ`);
    const got = t.file.name;
    assert.ok(got.length > 0, `${why}: the receiver produced no name to save under`);
    assert.ok(!got.includes('�'), `${why}: the name was cut mid-character and came back as "${got}"`);
    assert.ok(enc.encode(got).length <= 64, `${why}: "${got}" is ${enc.encode(got).length} bytes`);
    if (enc.encode(name).length <= 64 && name) assert.strictEqual(got, name, `${why}: name changed`);
  }
});
