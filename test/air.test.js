'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Air = require('../air.js');
const ch = require('./helpers/channel.js');

const FS = 48000;

async function transfer(bytes, name, opts) {
  const o = opts || {};
  const r = ch.rng(o.seed || 1);
  const prep = await Air.prepare(bytes, name);
  const tx = new Air.Sender(prep, { session: 9, papr: o.papr !== undefined ? o.papr : false });
  const rx = new Air.Receiver(FS);
  let sent = 0, delivered = 0;
  const cap = o.cap || 200;
  const progressLog = [];
  while (!rx.result && sent < cap) {
    let f = tx.nextFrame();
    sent++;
    if (o.skipFirst && sent <= o.skipFirst) continue;
    if (o.loss && r() < o.loss) continue;
    if (o.channel) f = o.channel(f, r);
    rx.push(ch.noise(o.gapNoise || 800, 1e-4, r));
    rx.push(f);
    delivered++;
    progressLog.push(rx.progress());
  }
  rx.push(ch.noise(FS, 1e-4, r));
  const file = await rx.file();
  return { rx, file, sent, delivered, prep, progressLog };
}

test('a small random file lands byte-perfect and uncompressed', async () => {
  const r = ch.rng(2);
  const bytes = new Uint8Array(5000).map(() => r.int(256));
  const t = await transfer(bytes, 'clean.bin', { seed: 3 });
  assert.ok(t.file, 'no file');
  assert.strictEqual(t.prep.flags & 1, 0, 'random bytes should not be gzipped');
  assert.strictEqual(Buffer.compare(Buffer.from(t.file.bytes), Buffer.from(bytes)), 0);
  assert.strictEqual(t.file.name, 'clean.bin');
  assert.strictEqual(t.rx.stats.dropletCrcFail, 0);
});

test('compressible content ships compressed and comes back identical', async () => {
  const text = 'the quick brown fox jumps over the lazy dog. '.repeat(700);
  const bytes = new TextEncoder().encode(text);
  const t = await transfer(bytes, 'notes.txt', { seed: 4 });
  assert.strictEqual(t.prep.flags & 1, 1, 'text should compress');
  assert.ok(t.prep.payload.length < bytes.length / 3, 'gzip should earn its keep: ' + t.prep.payload.length);
  assert.strictEqual(Buffer.compare(Buffer.from(t.file.bytes), Buffer.from(bytes)), 0);
});

test('30 percent frame loss: the fountain refills without passes', async () => {
  const r = ch.rng(5);
  const bytes = new Uint8Array(20000).map(() => r.int(256));
  const t = await transfer(bytes, 'lossy.bin', { seed: 6, loss: 0.3, cap: 120 });
  assert.ok(t.file, 'no file after ' + t.sent + ' frames');
  assert.strictEqual(Buffer.compare(Buffer.from(t.file.bytes), Buffer.from(bytes)), 0);
  const minFrames = Math.ceil(Math.ceil(20000 / 256) / Air.DROPLETS_PER_FRAME);
  assert.ok(t.sent < 2.2 * minFrames, `took ${t.sent} frames against a floor of ${minFrames}`);
});

test('a joiner who missed the first frames still gets everything', async () => {
  const r = ch.rng(7);
  const bytes = new Uint8Array(8000).map(() => r.int(256));
  const t = await transfer(bytes, 'late.bin', { seed: 8, skipFirst: 3 });
  assert.ok(t.file, 'no file');
  assert.strictEqual(Buffer.compare(Buffer.from(t.file.bytes), Buffer.from(bytes)), 0);
});

test('the whole chain survives noise, echo, comb and clock offset at once', async () => {
  const r0 = ch.rng(9);
  const bytes = new Uint8Array(12000).map(() => r0.int(256));
  const channel = (f, r) => ch.awgn(ch.comb(ch.sfo(ch.echoesFrac(f, FS, ch.ROOM_MEASURED), FS, 120), FS, 600, 12, r), 8, r);
  const t = await transfer(bytes, 'hard.bin', { seed: 10, channel, cap: 120, papr: true });
  assert.ok(t.file, 'no file: stats ' + JSON.stringify(t.rx.stats));
  assert.strictEqual(Buffer.compare(Buffer.from(t.file.bytes), Buffer.from(bytes)), 0);
});

test('progress is monotone and ends at 1', async () => {
  const r = ch.rng(11);
  const bytes = new Uint8Array(15000).map(() => r.int(256));
  const t = await transfer(bytes, 'prog.bin', { seed: 12, loss: 0.2, cap: 120 });
  assert.ok(t.file);
  for (let i = 1; i < t.progressLog.length; i++) {
    assert.ok(t.progressLog[i] >= t.progressLog[i - 1] - 1e-9, 'progress went backwards at ' + i);
  }
  assert.ok(Math.abs(t.progressLog[t.progressLog.length - 1] - 1) < 1e-9);
});

test('one megabyte through 30 percent loss, byte-perfect', { skip: !process.env.EARSHOT_SLOW && 'set EARSHOT_SLOW=1' }, async () => {
  const r = ch.rng(13);
  const bytes = new Uint8Array(1 << 20).map(() => r.int(256));
  const t = await transfer(bytes, 'big.bin', { seed: 14, loss: 0.3, cap: 4000 });
  assert.ok(t.file, 'no file after ' + t.sent + ' frames');
  assert.strictEqual(Buffer.compare(Buffer.from(t.file.bytes), Buffer.from(bytes)), 0);
  console.log(`      1 MB: ${t.sent} frames sent, ${t.delivered} heard, ` +
    `${(t.sent * Air.FRAME_SEC / 60).toFixed(1)} min of air`);
});

test('a passphrase encrypts, authenticates, and refuses the wrong guess', async () => {
  const text = 'meet me at the usual place at nine. '.repeat(300);
  const bytes = new TextEncoder().encode(text);
  const r = ch.rng(20);
  const prep = await Air.prepare(bytes, 'secret.txt', { passphrase: 'olive-tree-42' });
  assert.strictEqual(prep.flags & 2, 2);
  assert.strictEqual(prep.flags & 1, 1, 'compression should happen before encryption');
  const tx = new Air.Sender(prep, { session: 3, papr: false });
  const rx = new Air.Receiver(FS);
  let sent = 0;
  while (!rx.result && sent < 60) { rx.push(ch.noise(800, 1e-4, r)); rx.push(tx.nextFrame()); sent++; }
  assert.ok(rx.result && rx.result.crcOk, 'transfer incomplete');
  assert.strictEqual(rx.needsPassphrase(), true);
  await assert.rejects(() => rx.file(), (e) => e.needsPassphrase === true);
  await assert.rejects(() => rx.file({ passphrase: 'wrong-guess' }), /wrong passphrase/);
  const file = await rx.file({ passphrase: 'olive-tree-42' });
  assert.strictEqual(Buffer.compare(Buffer.from(file.bytes), Buffer.from(bytes)), 0);
  assert.strictEqual(file.name, 'secret.txt', 'the name comes back after unlocking');
});

test('a passphrase hides the file name too, and the manifest carries none', async () => {
  const bytes = new TextEncoder().encode('columns,of,readings\n'.repeat(200));
  const prep = await Air.prepare(bytes, 'payroll-2026.csv', { passphrase: 'olive-tree-42' });
  assert.strictEqual(prep.flags & 4, 4, 'the name-inside flag should be set');

  // Nothing on the air says what the file is called.
  const man = Air.parseManifest(prep.manifest);
  assert.strictEqual(man.name, '', 'the manifest name must be empty');
  assert.strictEqual(prep.manifest[13], 0, 'the manifest name length must be zero');
  assert.ok(!Buffer.from(prep.manifest).includes(Buffer.from('payroll')), 'the name is in the manifest');
  assert.ok(!Buffer.from(prep.payload).includes(Buffer.from('payroll')), 'the name is in the clear in the payload');

  // The size does stay in the clear: the receiver sizes its windows with it.
  assert.strictEqual(man.size, prep.payload.length);

  const r = ch.rng(21);
  const tx = new Air.Sender(prep, { session: 4, papr: false });
  const rx = new Air.Receiver(FS);
  let sent = 0;
  while (!rx.result && sent < 60) { rx.push(ch.noise(800, 1e-4, r)); rx.push(tx.nextFrame()); sent++; }
  assert.ok(rx.result && rx.result.crcOk, 'transfer incomplete');
  assert.strictEqual(rx.nameHidden(), true);
  assert.strictEqual(rx.result.manifest.name, '');
  const file = await rx.file({ passphrase: 'olive-tree-42' });
  assert.strictEqual(file.name, 'payroll-2026.csv');
  assert.strictEqual(Buffer.compare(Buffer.from(file.bytes), Buffer.from(bytes)), 0);
});

test('without a passphrase the name still travels in the manifest', async () => {
  const prep = await Air.prepare(new TextEncoder().encode('hi\n'), 'notes.txt');
  assert.strictEqual(prep.flags & 4, 0);
  assert.strictEqual(Air.parseManifest(prep.manifest).name, 'notes.txt');
});

test('the passphrase is used exactly as typed, and one of only spaces is refused', async () => {
  const bytes = new TextEncoder().encode('hello\n'.repeat(100));
  // A trailing space is part of the secret, not noise to be trimmed away.
  const prep = await Air.prepare(bytes, 'a.txt', { passphrase: 'pw ' });
  const r = ch.rng(22);
  const tx = new Air.Sender(prep, { session: 4, papr: false });
  const rx = new Air.Receiver(FS);
  let sent = 0;
  while (!rx.result && sent < 60) { rx.push(ch.noise(800, 1e-4, r)); rx.push(tx.nextFrame()); sent++; }
  await assert.rejects(() => rx.file({ passphrase: 'pw' }), /wrong passphrase/);
  const file = await rx.file({ passphrase: 'pw ' });
  assert.strictEqual(Buffer.compare(Buffer.from(file.bytes), Buffer.from(bytes)), 0);

  for (const p of ['', ' ', '   ', '\t']) {
    await assert.rejects(() => Air.prepare(bytes, 'a.txt', { passphrase: p }), /only spaces/,
      `a passphrase of ${JSON.stringify(p)} should be refused, not silently dropped`);
  }
  // No passphrase at all still means no encryption, and says so in the flags.
  const plain = await Air.prepare(bytes, 'a.txt');
  assert.strictEqual(plain.flags & 6, 0);
});

test('an empty file survives the name-inside wrapper', async () => {
  const prep = await Air.prepare(new Uint8Array(0), 'empty.bin', { passphrase: 'pw' });
  const r = ch.rng(23);
  const tx = new Air.Sender(prep, { session: 4, papr: false });
  const rx = new Air.Receiver(FS);
  let sent = 0;
  while (!rx.result && sent < 20) { rx.push(ch.noise(800, 1e-4, r)); rx.push(tx.nextFrame()); sent++; }
  const file = await rx.file({ passphrase: 'pw' });
  assert.strictEqual(file.name, 'empty.bin');
  assert.strictEqual(file.bytes.length, 0);
});

// ---------------------------------------------- scheduling and estimates

test('a trailing window gets air in proportion to its blocks, not an equal share', async () => {
  const r = ch.rng(31);
  const bytes = new Uint8Array(65537).map(() => r.int(256));    // 256 blocks, then 1
  const prep = await Air.prepare(bytes, 'edge.bin');
  assert.strictEqual(prep.windows.length, 2);
  const tx = new Air.Sender(prep, { session: 1 });
  const frames = Air.framesFor(prep.payload.length);
  for (let i = 0; i < frames; i++) tx.frameBytes();
  assert.ok(tx.nextId[0] >= 256, `the full window got only ${tx.nextId[0]} droplets in ${frames} frames`);
  assert.ok(tx.nextId[1] <= 4, `the one-block window took ${tx.nextId[1]} droplets`);
});

test('equal windows still go round in order', async () => {
  const r = ch.rng(32);
  const prep = await Air.prepare(new Uint8Array(131072).map(() => r.int(256)), 'even.bin');
  assert.strictEqual(prep.windows.length, 2);
  const tx = new Air.Sender(prep, { session: 1 });
  for (let i = 0; i < 10; i++) tx.frameBytes();
  assert.deepStrictEqual(tx.nextId, [15, 15]);
});

test('the frame the page quotes is the frame the sender plays', async () => {
  const prep = await Air.prepare(new Uint8Array(600), 'x.bin');
  assert.strictEqual(new Air.Sender(prep, { session: 2 }).nextFrame().length, Air.FRAME_SAMPLES);
  assert.strictEqual(Air.FRAME_SEC, Air.FRAME_SAMPLES / Air.FS);
  assert.strictEqual(Air.framesFor(0), 3);
  assert.strictEqual(Air.framesFor(768), 3);
  assert.strictEqual(Air.framesFor(769), 4);
  assert.strictEqual(Air.secondsFor(768), 3 * Air.FRAME_SEC);
});

test('the pre-send estimate is the size that actually goes on the air', async () => {
  const bytes = new TextEncoder().encode('the quick brown fox jumps over the lazy dog. '.repeat(700));
  const est = await Air.estimate(bytes);
  const prep = await Air.prepare(bytes, 'notes.txt');
  assert.strictEqual(est.bytes, prep.payload.length);
  assert.strictEqual(est.gzipped, true);
  assert.ok(est.frames * 3 < Air.framesFor(bytes.length), 'the quote should follow the compression');
  const sealed = await Air.estimate(bytes, { passphrase: 'olive-tree-42', name: 'notes.txt' });
  const prepSealed = await Air.prepare(bytes, 'notes.txt', { passphrase: 'olive-tree-42' });
  assert.strictEqual(sealed.bytes, prepSealed.payload.length);
});

test('a long name is trimmed on a character boundary and keeps its extension', () => {
  for (const [name, ext] of [['a' + 'é'.repeat(40) + '.txt', '.txt'], ['x'.repeat(60) + '.json', '.json'], ['📄'.repeat(17) + '.md', '.md']]) {
    const m = Air.parseManifest(Air.packManifest({ flags: 0, winCount: 1, size: 3, crc32: 0, name }));
    assert.ok(m.name.endsWith(ext), `${name} arrived as ${m.name}`);
    assert.ok(!m.name.includes('�'), 'a codepoint was cut in half: ' + m.name);
    assert.ok(new TextEncoder().encode(m.name).length <= Air.NAME_BYTES);
  }
  const empty = Air.parseManifest(Air.packManifest({ flags: 0, winCount: 1, size: 0, crc32: 0, name: '' }));
  assert.strictEqual(empty.name, 'file');
});

test('one push larger than the ring is taken in bites, not silently overwritten', async () => {
  // Handing a whole recording to push() in one call used to run the write
  // pointer past samples _drain had not read yet. Same stream, one call and
  // many, must decode the same.
  const r = ch.rng(31);
  const bytes = new Uint8Array(4000).map(() => r.int(256));
  const prep = await Air.prepare(bytes, 'whole.bin');
  const tx = new Air.Sender(prep, { session: 12, papr: false });
  const parts = [];
  for (let i = 0; i < 10; i++) { parts.push(ch.noise(800, 1e-4, r)); parts.push(tx.nextFrame()); }
  let n = 0;
  for (const p of parts) n += p.length;
  const air = new Float32Array(n);
  let off = 0;
  for (const p of parts) { air.set(p, off); off += p.length; }
  assert.ok(n > (1 << 16), 'the stream has to be bigger than one bite for this to mean anything');

  const chunked = new Air.Receiver(FS);
  for (let o = 0; o < n; o += 4096) chunked.push(air.subarray(o, Math.min(n, o + 4096)));
  const oneCall = new Air.Receiver(FS);
  oneCall.push(air);

  assert.deepStrictEqual(oneCall.stats, chunked.stats);
  const a = await oneCall.file(), b = await chunked.file();
  assert.strictEqual(Buffer.compare(Buffer.from(a.bytes), Buffer.from(bytes)), 0);
  assert.strictEqual(Buffer.compare(Buffer.from(b.bytes), Buffer.from(bytes)), 0);
});
