'use strict';
// Regression net for what goes on the air: the manifest, the droplet
// trailer, and where the file name lives when a passphrase is set. The
// wire decisions pinned here are W1 (magic 'Eb'), W2 (CRC-32 droplet
// trailers) and W3 (the name travels inside the ciphertext).
const test = require('node:test');
const assert = require('node:assert');
const Air = require('../air.js');
const Fountain = require('../fountain.js');
const Modem = require('../modem.js');
const ch = require('./helpers/channel.js');

const FS = 48000;

function base(patch) {
  return Object.assign({ flags: 0, winCount: 1, size: 300, crc32: 0x12345678, name: 'x.bin' }, patch);
}

// ------------------------------------------------------------------- W1

test("W1: the manifest magic is 'Eb', and the retired 'Ea' is refused", () => {
  const m = Air.packManifest(base());
  assert.strictEqual(m[0], 0x45, 'first magic byte');
  assert.strictEqual(m[1], 0x62, "second magic byte must be 'b'; 'a' (0x61) is the retired format");
  assert.ok(Air.parseManifest(m), 'a manifest this file just packed must parse');

  const old = Air.packManifest(base());
  old[0] = 0x45; old[1] = 0x61;                        // downgrade to the retired magic
  const crc = Modem.crc16(old, 0, old.length - 2);     // and make its CRC-16 honest again
  old[old.length - 2] = crc >> 8; old[old.length - 1] = crc & 0xFF;
  assert.strictEqual(Air.parseManifest(old), null, "the retired 'Ea' magic must be rejected outright");
});

// ------------------------------------------------------------------- W2

test('W2: a droplet is 266 bytes with a CRC-32 trailer, and three still fit a frame', async () => {
  assert.strictEqual(typeof Air.DROPLET_BYTES, 'number', 'air.js must export DROPLET_BYTES');
  assert.strictEqual(typeof Air.MANIFEST_BYTES, 'number', 'air.js must export MANIFEST_BYTES');
  assert.strictEqual(Air.MANIFEST_BYTES, 96);
  assert.strictEqual(Air.DROPLET_BYTES, 2 + 4 + Fountain.BLOCK + 4, 'win 2 + id 4 + payload 256 + crc32 4');
  assert.strictEqual(Air.DROPLET_BYTES, 266);
  assert.strictEqual(Air.DROPLETS_PER_FRAME, 3);
  assert.strictEqual(Air.FRAME_BYTES, 1043);
  const used = Air.MANIFEST_BYTES + Air.DROPLETS_PER_FRAME * Air.DROPLET_BYTES;
  assert.strictEqual(used, 894);
  assert.strictEqual(Air.FRAME_BYTES - used, 149, 'spare bytes left in a frame');

  // The trailer on a real frame has to be CRC-32 over window, id and payload.
  const prep = await Air.prepare(new Uint8Array(700).map((_, i) => (i * 7) & 0xFF), 'w2.bin');
  const frame = new Air.Sender(prep, { session: 1, papr: false }).frameBytes();
  const view = new DataView(frame.buffer, frame.byteOffset);
  for (let d = 0; d < Air.DROPLETS_PER_FRAME; d++) {
    const off = Air.MANIFEST_BYTES + d * Air.DROPLET_BYTES;
    const body = frame.subarray(off, off + 6 + Fountain.BLOCK);
    assert.strictEqual(view.getUint32(off + 6 + Fountain.BLOCK), Modem.crc32(body) >>> 0,
      `droplet ${d}: trailer is not the CRC-32 of window|id|payload`);
  }
});

// -------------------------------------------------------- manifest sanity

test('H2: a manifest that does not add up parses as null', () => {
  assert.strictEqual(typeof Air.MAX_PAYLOAD, 'number', 'air.js must export MAX_PAYLOAD, the manifest size cap');
  const bad = [
    ['winCount 5 for 300 bytes', { winCount: 5, size: 300 }],
    ['winCount 0', { winCount: 0, size: 300 }],
    ['winCount 1 for a two-window file', { winCount: 1, size: 65537 }],
    ['size past the cap', { winCount: Math.ceil((Air.MAX_PAYLOAD + 1) / 65536), size: Air.MAX_PAYLOAD + 1 }],
  ];
  for (const [label, patch] of bad) {
    assert.strictEqual(Air.parseManifest(Air.packManifest(base(patch))), null, `${label} was accepted`);
  }
  const good = [
    ['empty file', { winCount: 1, size: 0 }],
    ['one full window', { winCount: 1, size: 65536 }],
    ['one byte over', { winCount: 2, size: 65537 }],
    ['at the cap', { winCount: Math.max(1, Math.ceil(Air.MAX_PAYLOAD / 65536)), size: Air.MAX_PAYLOAD }],
  ];
  for (const [label, patch] of good) {
    assert.ok(Air.parseManifest(Air.packManifest(base(patch))), `${label} was rejected`);
  }
});

// ------------------------------------------------------------------- W3

test('W3: a passphrase hides the file name too, and unlocking gives it back', async () => {
  const bytes = new TextEncoder().encode('the plans. '.repeat(60));
  const name = 'quarterly plans.pdf';
  const prep = await Air.prepare(bytes, name, { passphrase: 'olive-tree-42' });
  assert.strictEqual(prep.flags & 2, 2, 'encrypted flag');
  assert.strictEqual(prep.flags & 4, 4, 'W3: bit 2 says the name is inside the payload');

  const onAir = Air.parseManifest(prep.manifest);
  assert.strictEqual(onAir.name, '', `the name went out in the clear as "${onAir.name}"`);
  const clear = Buffer.from(prep.manifest).toString('latin1') + Buffer.from(prep.payload).toString('latin1');
  assert.ok(!clear.includes('quarterly'), 'the file name is readable somewhere on the air');

  const r = ch.rng(501);
  const tx = new Air.Sender(prep, { session: 3, papr: false });
  const rx = new Air.Receiver(FS);
  let n = 0;
  while (!rx.result && n < 20) { rx.push(ch.noise(800, 1e-4, r)); rx.push(tx.nextFrame()); n++; }
  assert.ok(rx.result && rx.result.crcOk, 'the encrypted transfer never completed');
  assert.strictEqual(rx.needsPassphrase(), true);
  assert.strictEqual(rx.result.manifest.name, '', 'the receiver knows the name before unlocking');

  const file = await rx.file({ passphrase: 'olive-tree-42' });
  assert.strictEqual(file.name, name, 'unlocking did not reveal the real name');
  assert.strictEqual(Buffer.compare(Buffer.from(file.bytes), Buffer.from(bytes)), 0);
});

// ------------------------------------------------------------------- M4

test('M4: a passphrase keeps its spaces, at both ends', async () => {
  // Passes on 0.9.0 and must keep passing: the page fix is to stop trimming,
  // which only works if Air never normalises a passphrase either.
  const bytes = new TextEncoder().encode('spaces matter. '.repeat(40));
  const pass = 'open sesame ';                          // trailing space on purpose
  const prep = await Air.prepare(bytes, 'spaced.txt', { passphrase: pass });
  const r = ch.rng(511);
  const tx = new Air.Sender(prep, { session: 4, papr: false });
  const rx = new Air.Receiver(FS);
  let n = 0;
  while (!rx.result && n < 20) { rx.push(ch.noise(800, 1e-4, r)); rx.push(tx.nextFrame()); n++; }
  assert.ok(rx.result && rx.result.crcOk);
  await assert.rejects(() => rx.file({ passphrase: pass.trim() }), /wrong passphrase/,
    'a trimmed passphrase must not open a file locked with the untrimmed one');
  const file = await rx.file({ passphrase: pass });
  assert.strictEqual(Buffer.compare(Buffer.from(file.bytes), Buffer.from(bytes)), 0);
});
