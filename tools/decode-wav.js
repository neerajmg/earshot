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
const FFT = require('../fft.js');
const Air = require('../air.js');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args.splice(outIdx, 2)[1] : null;
const passIdx = args.indexOf('--pass');
const passphrase = passIdx >= 0 ? args.splice(passIdx, 2)[1] : undefined;
const ofdm = args.includes('--ofdm');
if (ofdm) args.splice(args.indexOf('--ofdm'), 1);
const [wavPath, presetName] = args;
if (!wavPath) { console.error('usage: node tools/decode-wav.js recording.wav [robust|fast] [--ofdm] [--pass phrase] [--out file]'); process.exit(2); }

if (ofdm) {
  (async () => {
    const buf0 = fs.readFileSync(wavPath);
    const wav = DSP.wavDecode(buf0.buffer.slice(buf0.byteOffset, buf0.byteOffset + buf0.byteLength));
    let x = wav.samples;
    if (wav.fs !== Air.FS) {
      console.log(`resampling ${wav.fs} -> ${Air.FS}`);
      x = FFT.sincResample(x, wav.fs, Air.FS);
    }
    let peak = 0;
    for (const v of x) if (Math.abs(v) > peak) peak = Math.abs(v);
    console.log(`${path.basename(wavPath)}: ${wav.fs} Hz, ${(x.length / Air.FS).toFixed(1)} s, peak ${peak.toFixed(3)}, engine ofdm`);
    const rx = new Air.Receiver(Air.FS, {
      onFrame: (f) => {
        const m = f.manifest;
        console.log(`frame: droplets ${f.stats.droplets}, bad ${f.stats.dropletCrcFail}, sig fails ${f.stats.sigFail}` +
          (m ? `, ${m.name} ${(f.progress * 100).toFixed(0)} %` : ', no manifest yet'));
      },
    });
    for (let off = 0; off < x.length; off += 4096) rx.push(x.subarray(off, Math.min(x.length, off + 4096)));
    console.log('stats:', JSON.stringify(rx.stats));
    if (!rx.result) { console.log('transfer incomplete'); process.exit(1); }
    console.log(`complete: ${rx.result.manifest.name}, CRC ${rx.result.crcOk ? 'ok' : 'BAD'}` + (rx.needsPassphrase() ? ', encrypted' : ''));
    try {
      const f = await rx.file({ passphrase });
      if (outPath) { fs.writeFileSync(outPath, f.bytes); console.log('wrote ' + outPath + ' (' + f.bytes.length + ' bytes)'); }
      process.exit(0);
    } catch (e) {
      console.log(e.message);
      process.exit(1);
    }
  })();
} else {
mainFsk();
}

function mainFsk() {
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
}
