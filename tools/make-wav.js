#!/usr/bin/env node
// Renders a file to a modem WAV without the browser.
//
//   node tools/make-wav.js input.bin out.wav [robust|fast] [passes] [rate]
'use strict';
const fs = require('fs');
const path = require('path');
const Modem = require('../modem.js');
const DSP = require('../dsp.js');

const [inPath, outPath, presetName, passesStr, rateStr] = process.argv.slice(2);
if (!inPath || !outPath) { console.error('usage: node tools/make-wav.js input.bin out.wav [robust|fast] [passes] [rate]'); process.exit(2); }
const preset = Modem.PRESETS[presetName || 'robust'];
const passes = Math.max(1, Number(passesStr) || 1);
const fsr = Number(rateStr) || 48000;
const bytes = new Uint8Array(fs.readFileSync(inPath));
const sender = new Modem.Sender(bytes, path.basename(inPath));
const seq = sender.passSequence();
const parts = [new Float32Array(fsr)];                       // one second of silence to settle the noise floor
for (let p = 0; p < passes; p++) for (const raw of seq) parts.push(DSP.modulateFrame(Modem.frameToBits(raw, p), preset, fsr));
parts.push(new Float32Array(fsr / 2));
let n = 0; for (const x of parts) n += x.length;
const all = new Float32Array(n);
let off = 0; for (const x of parts) { all.set(x, off); off += x.length; }
fs.writeFileSync(outPath, Buffer.from(DSP.wavEncode(all, fsr)));
console.log(`${outPath}: ${seq.length} frames x ${passes} pass(es), ${(n / fsr).toFixed(1)} s at ${fsr} Hz, session ${sender.session}`);
