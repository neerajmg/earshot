#!/usr/bin/env node
// Finds tone pairs that actually survive the speaker-to-microphone path here.
//
// A laptop speaker firing into a microphone a few centimetres away is a comb
// filter, not a flat channel, and where the peaks and nulls land depends on
// the machine, the desk and the distance. Indirect measurements (tone sweeps)
// are easy to misalign, so this plays real modem frames on every candidate
// pair and reports which ones decode.
//
//   node tools/find-tones.js --make probe.wav   # write the probe
//   node tools/find-tones.js --report rec.wav   # decode a recording of it
//   node tools/find-tones.js                    # play and record (macOS)
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const Modem = require('../modem.js');
const DSP = require('../dsp.js');

// Every candidate: both tones a whole number of cycles per symbol and a
// spacing that is a multiple of the baud rate.
const CANDIDATES = [
  { name: '1500/2100@300', baud: 300, spaceHz: 1500, markHz: 2100, gapSec: 0.15 },
  { name: '1200/1500@300', baud: 300, spaceHz: 1200, markHz: 1500, gapSec: 0.15 },
  { name: '2100/2700@300', baud: 300, spaceHz: 2100, markHz: 2700, gapSec: 0.15 },
  { name: '1950/2250@150', baud: 150, spaceHz: 1950, markHz: 2250, gapSec: 0.15 },
  { name: '2550/3000@150', baud: 150, spaceHz: 2550, markHz: 3000, gapSec: 0.15 },
  { name: '1350/1650@150', baud: 150, spaceHz: 1350, markHz: 1650, gapSec: 0.15 },
  { name: '750/1050@150',  baud: 150, spaceHz: 750,  markHz: 1050, gapSec: 0.15 },
  { name: '3000/3450@150', baud: 150, spaceHz: 3000, markHz: 3450, gapSec: 0.15 },
];
for (const c of CANDIDATES) {
  if (c.markHz % c.baud || c.spaceHz % c.baud || (c.markHz - c.spaceHz) % c.baud) throw new Error('not orthogonal: ' + c.name);
}
const FRAMES_PER_CANDIDATE = 2;
const FSR = 48000;

function probeFrames(i) {
  // A distinct session per candidate keeps the receivers from mixing them up.
  const payload = new Uint8Array(32).map((_, k) => (i * 40 + k) & 0xFF);
  const out = [];
  for (let f = 0; f < FRAMES_PER_CANDIDATE; f++) {
    out.push(Modem.buildFrame({ kind: Modem.KIND.DATA, session: i & 0x0F, seq: f, len: 32, payload }));
  }
  return out;
}

function makeProbe(outPath) {
  const parts = [new Float32Array(FSR)];
  for (let i = 0; i < CANDIDATES.length; i++) {
    for (const raw of probeFrames(i)) parts.push(DSP.modulateFrame(Modem.frameToBits(raw, 0), CANDIDATES[i], FSR));
    parts.push(new Float32Array(Math.round(0.6 * FSR)));
  }
  parts.push(new Float32Array(FSR));
  let n = 0; for (const p of parts) n += p.length;
  const all = new Float32Array(n); let off = 0; for (const p of parts) { all.set(p, off); off += p.length; }
  fs.writeFileSync(outPath, Buffer.from(DSP.wavEncode(all, FSR)));
  return n / FSR;
}

function report(recPath) {
  const buf = fs.readFileSync(recPath);
  const wav = DSP.wavDecode(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  let peak = 0; for (const v of wav.samples) if (Math.abs(v) > peak) peak = Math.abs(v);
  console.log(`${path.basename(recPath)}: ${wav.fs} Hz, ${(wav.samples.length / wav.fs).toFixed(1)} s, peak ${peak.toFixed(3)}`);
  if (peak < 0.005) console.log('  the recording is almost silent: check the output device, volume and mute');
  const rows = [];
  for (let i = 0; i < CANDIDATES.length; i++) {
    const c = CANDIDATES[i];
    const want = probeFrames(i).map((raw) => Modem.frameToBits(raw, 0));
    let ok = 0, syncs = 0, bitErr = 0, compared = 0, snr = [], bal = [];
    const demod = new DSP.Demodulator(c, wav.fs, {
      onSync: (s) => { syncs++; snr.push(s.snrDb); bal.push(s.balanceDb); },
      onFrame: (f) => {
        let best = Infinity;
        for (const w of want) { let e = 0; for (let k = 0; k < w.length; k++) if (f.bits[k] !== w[k]) e++; if (e < best) best = e; }
        if (best < 0.35 * f.bits.length) { bitErr += best; compared += f.bits.length; }
        const p = Modem.parseFrame(Modem.bitsToFrame(f.bits).raw);
        if (p.crcOk) ok++;
        return p.crcOk;
      },
    });
    for (let off = 0; off < wav.samples.length; off += 4096) demod.push(wav.samples.subarray(off, Math.min(wav.samples.length, off + 4096)));
    const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
    rows.push({ name: c.name, ok, syncs, ber: compared ? bitErr / compared : NaN, snr: mean(snr), bal: mean(bal) });
  }
  console.log('');
  console.log('pair            frames ok  syncs   raw BER  est SNR  tone balance');
  for (const r of rows) {
    console.log(`${r.name.padEnd(15)} ${String(r.ok + '/' + FRAMES_PER_CANDIDATE).padStart(9)} ${String(r.syncs).padStart(6)}   ${Number.isFinite(r.ber) ? r.ber.toFixed(4) : '     -'}   ${Number.isFinite(r.snr) ? r.snr.toFixed(1).padStart(6) : '     -'}   ${Number.isFinite(r.bal) ? r.bal.toFixed(1).padStart(6) : '     -'}`);
  }
  const winners = rows.filter((r) => r.ok === FRAMES_PER_CANDIDATE).sort((a, b) => a.ber - b.ber || Math.abs(a.bal) - Math.abs(b.bal));
  console.log('');
  if (winners.length) {
    console.log('usable here, best first: ' + winners.map((w) => w.name).join(', '));
    const w = CANDIDATES.find((c) => c.name === winners[0].name);
    console.log(`add to PRESETS in modem.js:  room: { name: 'room', baud: ${w.baud}, spaceHz: ${w.spaceHz}, markHz: ${w.markHz}, gapSec: ${w.gapSec} },`);
  } else {
    console.log('nothing decoded: raise the volume, move the microphone closer, or check the output device');
  }
  return winners.length > 0;
}

const args = process.argv.slice(2);
const mkIdx = args.indexOf('--make');
const rpIdx = args.indexOf('--report');
if (mkIdx >= 0) { console.log(`${makeProbe(args[mkIdx + 1]).toFixed(1)} s probe, ${CANDIDATES.length} pairs`); process.exit(0); }
if (rpIdx >= 0) { process.exit(report(args[rpIdx + 1]) ? 0 : 1); }

// Play and record in one go (macOS: afplay plus ffmpeg on avfoundation).
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'modem-tones-'));
const probe = path.join(work, 'probe.wav'), rec = path.join(work, 'rec.wav');
const dur = makeProbe(probe);
let mic = process.env.MIC_INDEX;
if (!mic) {
  const list = execFileSync('sh', ['-c', 'ffmpeg -hide_banner -f avfoundation -list_devices true -i "" 2>&1 || true']).toString();
  const m = list.match(/\[(\d+)\] (?:MacBook.*Microphone|Built-in Microphone)/);
  if (!m) { console.error('could not find the built-in microphone; set MIC_INDEX. Devices:\n' + list); process.exit(2); }
  mic = m[1];
}
console.log(`probe ${dur.toFixed(1)} s, recording from mic :${mic}`);
const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'avfoundation', '-i', ':' + mic, '-t', String(Math.ceil(dur + 4)), '-ac', '1', '-ar', String(FSR), '-sample_fmt', 's16', rec], { stdio: 'inherit' });
setTimeout(() => {
  try { execFileSync('afplay', [probe]); } catch (e) { console.error('afplay failed: ' + e.message); }
  setTimeout(() => {
    try { process.kill(ff.pid, 'SIGKILL'); } catch (e) { /* already gone */ }
    setTimeout(() => {
      const okAny = report(rec);
      fs.copyFileSync(rec, path.join(process.cwd(), 'find-tones-recording.wav'));
      console.log('\nrecording kept as find-tones-recording.wav');
      fs.rmSync(work, { recursive: true, force: true });
      process.exit(okAny ? 0 : 1);
    }, 700);
  }, 2000);
}, 1500);
