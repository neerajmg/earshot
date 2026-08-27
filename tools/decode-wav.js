#!/usr/bin/env node
// Decodes a WAV recording with the same code the page uses and prints what
// happened, frame by frame. Handy for recordings made with the receiver's
// "record mic to WAV" box.
//
//   node tools/decode-wav.js recording.wav [robust|fast] [--out received.bin]
'use strict';
const fs = require('fs');
const path = require('path');
const Modem = require('../modem.js');
const DSP = require('../dsp.js');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
const [wavPath, presetName] = args;
if (!wavPath) { console.error('usage: node tools/decode-wav.js recording.wav [robust|fast] [--out file]'); process.exit(2); }
const preset = Modem.PRESETS[presetName || 'robust'];
if (!preset) { console.error('unknown preset ' + presetName); process.exit(2); }

const buf = fs.readFileSync(wavPath);
const wav = DSP.wavDecode(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
let peak = 0;
for (const v of wav.samples) if (Math.abs(v) > peak) peak = Math.abs(v);
console.log(`${path.basename(wavPath)}: ${wav.fs} Hz, ${(wav.samples.length / wav.fs).toFixed(1)} s, peak ${peak.toFixed(3)}, preset ${preset.name}`);

const rx = new Modem.Receiver();
const demod = new DSP.Demodulator(preset, wav.fs, {
  onSync: (s) => console.log(`${(s.t0 / wav.fs).toFixed(2).padStart(7)} s  sync  corr ${s.corr.toFixed(2)}  sync errors ${s.syncErrors}  SNR ${s.snrDb.toFixed(1)} dB  balance ${s.balanceDb.toFixed(1)} dB${s.dfe ? '  dfe b=' + s.dfe.b.map((v) => v.toFixed(2)).join(',') : ''}`),
  onFrame: (f) => {
    const d = Modem.bitsToFrame(f.bits);
    const r = rx.accept(d.raw);
    const ok = r.kind !== 'crcfail' && r.kind !== 'bad';
    console.log(`${(f.t0 / wav.fs).toFixed(2).padStart(7)} s  frame ${r.kind}${r.seq !== undefined ? ' ' + r.seq : ''}  fixed ${d.corrected}  uncorrectable ${d.uncorrectable}  margin ${f.softMargin.toFixed(2)}`);
    return ok;
  },
});
for (let off = 0; off < wav.samples.length; off += 4096) demod.push(wav.samples.subarray(off, Math.min(wav.samples.length, off + 4096)));

const st = demod.stats;
console.log(`syncs ${st.syncs}, rejected syncs ${st.falseSyncs}, frames ${st.frames}, ok ${st.framesOk}`);
if (rx.meta) {
  console.log(`file ${rx.meta.name}: ${rx.meta.size} bytes, ${rx.meta.totalFrames - rx.missing()} / ${rx.meta.totalFrames} frames, complete ${rx.isComplete()}`);
  if (rx.isComplete() && outPath) { fs.writeFileSync(outPath, rx.assemble().bytes); console.log('wrote ' + outPath); }
} else {
  console.log('no START frame seen');
}
process.exit(rx.isComplete() ? 0 : 1);
