#!/usr/bin/env node
// End-to-end evaluation through the simulated channel.
//
// For every scenario and preset: a file goes through Sender -> modulator ->
// channel -> Demodulator -> Receiver until the receiver has the file or the
// pass limit is hit. Every random choice is seeded, so numbers repeat.
//
//   node tools/eval.js               full matrix, prints a table
//   node tools/eval.js --quick       fewer scenarios
//   node tools/eval.js --md out.md   also write the tables as Markdown
'use strict';
const fs = require('fs');
const Modem = require('../modem.js');
const DSP = require('../dsp.js');
const ch = require('../test/helpers/channel.js');

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const mdIdx = args.indexOf('--md');
const mdPath = mdIdx >= 0 ? args[mdIdx + 1] : null;

const FILE_BYTES = quick ? 400 : 1000;
const MAX_PASSES = 6;
const ECHOES = {
  mild: [[0.0013, -10], [0.011, -14], [0.019, -18]],
  desk: undefined,                                        // channel.js default: -6 dB desk plus walls
  harsh: [[0.007, -6], [0.013, -9], [0.023, -12]],        // every tap half a period of 1500 Hz: notch
};

const SCENARIOS = [
  { name: 'clean' },
  { name: 'AWGN 10 dB', snr: 10 },
  { name: 'AWGN 0 dB', snr: 0 },
  { name: 'AWGN -5 dB', snr: -5 },
  { name: 'AWGN -10 dB', snr: -10 },
  { name: 'TX 44.1k, RX 48k', txFs: 44100 },
  { name: 'TX 48k, RX 44.1k', rxFs: 44100 },
  { name: 'TX 16k, RX 48k', txFs: 16000 },
  { name: 'drift +200 ppm', ppm: 200 },
  { name: 'drift -200 ppm', ppm: -200 },
  { name: 'quiet -40 dB, 10 dB', gain: 0.01, snr: 10 },
  { name: 'clipped x10', gain: 10, clip: 1 },
  { name: 'bandpass 1-3.5k, 10 dB', bandpass: [1000, 3500], snr: 10 },
  { name: 'echo mild, 15 dB', echo: 'mild', snr: 15 },
  { name: 'echo desk -6 dB, 15 dB', echo: 'desk', snr: 15 },
  { name: 'echo notch 1500 Hz', echo: 'harsh', snr: 15 },
  { name: '25 % frames lost', frameLoss: 0.25 },
  { name: '60 ms burst per frame', burstMs: 60 },
  { name: 'room: mild echo, band, drift, 44.1k, 8 dB', echo: 'mild', bandpass: [800, 4000], ppm: 120, txFs: 44100, snr: 8 },
].filter((s) => !quick || ['clean', 'AWGN 0 dB', 'TX 44.1k, RX 48k', 'echo desk -6 dB, 15 dB', '25 % frames lost', 'room: mild echo, band, drift, 44.1k, 8 dB'].includes(s.name));

const SNR_SWEEP = quick ? [5, 0, -5, -10] : [10, 5, 2.5, 0, -2.5, -5, -7.5, -10, -12.5, -15];

// One pass of audio for a scenario. Returns {signal, rxFs}.
function renderPass(seq, preset, sc, r, pass) {
  const txFs = sc.txFs || 48000, rxFs = sc.rxFs || 48000;
  const parts = [ch.noise(Math.round(0.5 * txFs), 1e-4, r)];
  for (const raw of seq) {
    let x = DSP.modulateFrame(Modem.frameToBits(raw, pass || 0), preset, txFs);
    if (sc.frameLoss && r() < sc.frameLoss) x = new Float32Array(x.length);
    if (sc.burstMs) {
      const at = Math.round((64 + r() * 500) * txFs / preset.baud);
      x = ch.burst(x, at, Math.round(sc.burstMs / 1000 * txFs), r, r() < 0.5 ? 'zero' : 'noise');
    }
    parts.push(x);
  }
  parts.push(ch.noise(Math.round(0.3 * txFs), 1e-4, r));
  let x = ch.concat(parts);
  if (sc.echo) x = ch.echoes(x, txFs, ECHOES[sc.echo]);
  if (sc.bandpass) x = ch.bandpass(x, txFs, sc.bandpass[0], sc.bandpass[1]);
  if (sc.ppm) x = ch.drift(x, txFs, sc.ppm);
  if (txFs !== rxFs) x = ch.resampleLinear(x, txFs, rxFs);
  if (sc.gain) x = ch.gain(x, sc.gain);
  if (sc.clip) x = ch.clip(x, sc.clip);
  if (sc.snr !== undefined) x = ch.awgn(x, sc.snr, r);
  return { signal: x, rxFs: rxFs };
}

function hamming(a, b) { let e = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) e++; return e; }

function runScenario(sc, preset, seed) {
  const r = ch.rng(seed);
  const file = new Uint8Array(FILE_BYTES).map(() => r.int(256));
  const sender = new Modem.Sender(file, 'eval.bin', { session: 7 });
  const seq = sender.passSequence();
  const expectedBits = seq.map((raw) => Modem.frameToBits(raw));
  const rx = new Modem.Receiver();
  const res = { sent: 0, ok: 0, crcFail: 0, syncs: 0, falseSyncs: 0, bitErrors: 0, bitsCompared: 0, fixed: 0, garbage: 0, passes: 0, audioSec: 0, cpuMs: 0, complete: false, bytesMatch: false, firstPassOk: 0, snrDb: [], dfe: 0 };
  let demod = null, rxFs = 0;
  const cur = { pass: 0 };                 // the onFrame closure below reads this, not the loop variable
  for (let pass = 0; pass < MAX_PASSES && !rx.isComplete(); pass++) {
    cur.pass = pass;
    const pr = renderPass(seq, preset, sc, r, pass);
    if (!demod || rxFs !== pr.rxFs) {
      rxFs = pr.rxFs;
      demod = new DSP.Demodulator(preset, rxFs, {
        onSync: (s) => { res.syncs++; res.snrDb.push(s.snrDb); if (s.dfe) res.dfe++; },
        onFrame: (f) => {
          const d = Modem.bitsToFrame(f.bits);
          const p = Modem.parseFrame(d.raw);
          const a = rx.accept(d.raw);
          let best = Infinity;
          for (const eb of expectedBits) { const e = hamming(f.bits, eb); if (e < best) best = e; }
          if (best > 0.35 * f.bits.length) res.garbage++; else { res.bitErrors += best; res.bitsCompared += f.bits.length; }
          res.fixed += d.corrected;
          const ok = p.crcOk && a.kind !== 'bad';
          if (ok) { res.ok++; if (cur.pass === 0) res.firstPassOk++; } else res.crcFail++;
          return ok;
        },
      });
    }
    res.sent += seq.length;
    res.audioSec += pr.signal.length / rxFs;
    const t = process.hrtime.bigint();
    for (let off = 0; off < pr.signal.length; off += 4096) demod.push(pr.signal.subarray(off, Math.min(pr.signal.length, off + 4096)));
    res.cpuMs += Number(process.hrtime.bigint() - t) / 1e6;
    res.passes = pass + 1;
  }
  res.falseSyncs = demod.stats.falseSyncs;
  res.complete = rx.isComplete();
  if (res.complete) { const out = rx.assemble().bytes; res.bytesMatch = out.length === file.length && hamming(out, file) === 0; }
  res.frames = seq.length;
  res.throughput = res.complete ? file.length / res.audioSec : 0;
  res.ber = res.bitsCompared ? res.bitErrors / res.bitsCompared : 0;
  res.meanSnr = res.snrDb.length ? res.snrDb.reduce((a, b) => a + b, 0) / res.snrDb.length : NaN;
  res.rtf = res.audioSec / (res.cpuMs / 1000);
  return res;
}

function pad(s, n, right) { s = String(s); return right ? s.padStart(n) : s.padEnd(n); }
function fmt(v, d) { return Number.isFinite(v) ? v.toFixed(d) : '-'; }

const lines = [], md = [];
function out(line, mdLine) { lines.push(line); console.log(line); if (mdLine !== undefined) md.push(mdLine); }

out(`End-to-end eval: ${FILE_BYTES}-byte file, up to ${MAX_PASSES} passes, seeded.`, `# End-to-end eval\n\n${FILE_BYTES}-byte file, up to ${MAX_PASSES} passes, seeded. Frame counts include START frames. SNR is full-band AWGN relative to the signal RMS; the demodulator's own SNR estimate (in one baud of bandwidth) is in the last column.\n`);
out('');
const header = `${pad('scenario', 40)} ${pad('preset', 7)} ${pad('result', 9)} ${pad('passes', 6, 1)} ${pad('pass1 ok', 9, 1)} ${pad('frames ok/seen', 15, 1)} ${pad('rejected', 8, 1)} ${pad('raw BER', 8, 1)} ${pad('fixed/fr', 8, 1)} ${pad('B/s', 6, 1)} ${pad('RTF', 6, 1)} ${pad('est SNR', 8, 1)}`;
out(header, '| scenario | preset | result | passes | pass 1 ok | frames ok / seen | rejected syncs | raw BER | bits fixed per frame | B/s | real-time factor | est. SNR dB |\n|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
out('-'.repeat(header.length));
let seed = 1000;
const summary = { total: 0, complete: 0 };
for (const sc of SCENARIOS) {
  for (const preset of [Modem.PRESETS.robust, Modem.PRESETS.fast]) {
    const r = runScenario(sc, preset, seed++);
    summary.total++; if (r.complete && r.bytesMatch) summary.complete++;
    const result = r.complete ? (r.bytesMatch ? 'ok' : 'CRC?!') : 'FAILED';
    const cells = [sc.name, preset.name, result, r.passes, `${r.firstPassOk}/${r.frames}`, `${r.ok}/${r.ok + r.crcFail}`, r.falseSyncs, fmt(r.ber, 4), fmt(r.fixed / Math.max(1, r.ok + r.crcFail), 1), fmt(r.throughput, 1), fmt(r.rtf, 0) + 'x', r.meanSnr > 60 ? '>60' : fmt(r.meanSnr, 1)];
    out(`${pad(cells[0], 40)} ${pad(cells[1], 7)} ${pad(cells[2], 9)} ${pad(cells[3], 6, 1)} ${pad(cells[4], 9, 1)} ${pad(cells[5], 15, 1)} ${pad(cells[6], 8, 1)} ${pad(cells[7], 8, 1)} ${pad(cells[8], 8, 1)} ${pad(cells[9], 6, 1)} ${pad(cells[10], 6, 1)} ${pad(cells[11], 8, 1)}`, '| ' + cells.join(' | ') + ' |');
  }
}
out('');
out(`${summary.complete} of ${summary.total} scenario runs delivered the file byte-for-byte.`, `\n${summary.complete} of ${summary.total} scenario runs delivered the file byte-for-byte.\n`);

// Sensitivity: single pass, frame success against full-band SNR.
out('');
out('Sensitivity, single pass, frames ok / sent at full-band SNR (dB):', '## Sensitivity\n\nSingle pass, frames ok / sent, full-band AWGN SNR in dB.\n');
const sweepHeader = `${pad('preset', 7)} ` + SNR_SWEEP.map((s) => pad(s, 8, 1)).join(' ');
out(sweepHeader, '| preset | ' + SNR_SWEEP.map((s) => s + ' dB').join(' | ') + ' |\n|---|' + SNR_SWEEP.map(() => '---:').join('|') + '|');
for (const preset of [Modem.PRESETS.robust, Modem.PRESETS.fast]) {
  const cells = [];
  for (const snr of SNR_SWEEP) {
    const r = ch.rng(seed++);
    const file = new Uint8Array(quick ? 200 : 600).map(() => r.int(256));
    const seq = new Modem.Sender(file, 'sweep.bin', { session: 3 }).passSequence();
    const pr = renderPass(seq, preset, { snr: snr }, r);
    let ok = 0;
    const demod = new DSP.Demodulator(preset, pr.rxFs, { onFrame: (f) => { const p = Modem.parseFrame(Modem.bitsToFrame(f.bits).raw); if (p.crcOk) ok++; return p.crcOk; } });
    demod.push(pr.signal);
    cells.push(`${ok}/${seq.length}`);
  }
  out(`${pad(preset.name, 7)} ` + cells.map((c) => pad(c, 8, 1)).join(' '), `| ${preset.name} | ` + cells.join(' | ') + ' |');
}
out('');
out('Full-band SNR understates what the correlators see: one baud of bandwidth at 48 kHz is 22 dB narrower than full band for robust, 16 dB for fast.', '\nFull-band SNR understates what the correlators see: one baud of bandwidth at 48 kHz is 22 dB narrower than full band for robust, 16 dB for fast.\n');
if (mdPath) { fs.writeFileSync(mdPath, md.join('\n') + '\n'); console.log('wrote ' + mdPath); }
